use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, RunEvent, State};

/// persistent Python 사이드카 — 앱당 1개, stdin/stdout JSON 라인 프로토콜.
/// 매 병합마다 새로 띄우면 인터프리터 + fonttools import 비용(수 초)을 반복 지불하므로
/// 한 번 띄워 재사용하고, 죽으면 다음 요청에서 재기동한다.
struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Sidecar {
    fn spawn(scripts_dir: &Path) -> Result<Self, String> {
        // 개발 단계: scripts/.venv의 Python을 직접 실행 (Phase 5에서 PyInstaller 번들로 교체)
        let python = scripts_dir
            .join(".venv")
            .join(if cfg!(windows) { "Scripts" } else { "bin" })
            .join(if cfg!(windows) { "python.exe" } else { "python" });
        if !python.is_file() {
            return Err(format!(
                "사이드카 Python이 없습니다: {} — scripts/에서 `uv sync`를 실행하세요",
                python.display()
            ));
        }

        let mut cmd = Command::new(&python);
        cmd.arg("sidecar.py")
            .current_dir(scripts_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()); // fontTools 경고는 dev 콘솔로
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — 콘솔 창 뜸 방지
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("사이드카 실행 실패: {e}"))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        Ok(Self { child, stdin, stdout })
    }

    fn request(&mut self, req: &Value) -> Result<Value, String> {
        let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("사이드카 쓰기 실패: {e}"))?;

        let mut resp = String::new();
        let n = self
            .stdout
            .read_line(&mut resp)
            .map_err(|e| format!("사이드카 읽기 실패: {e}"))?;
        if n == 0 {
            return Err("사이드카가 종료되었습니다".into());
        }
        serde_json::from_str(&resp).map_err(|e| format!("사이드카 응답 파싱 실패: {e} — {resp}"))
    }
}

struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
    /// 프론트에서 업로드한 슬롯별 폰트의 임시 파일 경로 ("a" | "b")
    fonts: Mutex<HashMap<String, PathBuf>>,
    /// 마지막(현재 미리보기 중인) 병합 결과 — export 대상
    last_merged: Mutex<Option<Vec<u8>>>,
    scripts_dir: PathBuf,
    work_dir: PathBuf,
    seq: AtomicU64,
}

/// 사이드카에 요청 하나를 보낸다. 죽어 있으면 (재)기동하고, 실패하면 버려서
/// 다음 요청 때 새로 뜨게 한다.
fn sidecar_call(state: &AppState, req: Value) -> Result<Value, String> {
    let mut guard = state.sidecar.lock().unwrap();

    let dead = match guard.as_mut() {
        None => true,
        Some(s) => s.child.try_wait().map(|st| st.is_some()).unwrap_or(true),
    };
    if dead {
        if let Some(mut s) = guard.take() {
            let _ = s.child.kill();
        }
        *guard = Some(Sidecar::spawn(&state.scripts_dir)?);
    }

    let result = guard.as_mut().unwrap().request(&req);
    if result.is_err() {
        if let Some(mut s) = guard.take() {
            let _ = s.child.kill();
        }
    }
    result
}

/// 프론트가 고른 폰트 바이트를 임시 파일로 저장한다.
/// (웹뷰의 File 객체는 실제 경로를 노출하지 않으므로 바이트로 받는다)
#[tauri::command]
fn upload_font(request: Request<'_>, state: State<'_, AppState>) -> Result<(), String> {
    let slot = request
        .headers()
        .get("slot")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if slot != "a" && slot != "b" {
        return Err(format!("잘못된 슬롯: '{slot}'"));
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("바이너리 본문이 필요합니다".into());
    };
    // 슬롯 고정 파일명을 쓰면 스왑 후 재업로드가 반대 슬롯 파일을 덮어쓴다 — 항상 유니크하게
    let n = state.seq.fetch_add(1, Ordering::Relaxed);
    let path = state.work_dir.join(format!("upload_{n}.ttf"));
    std::fs::write(&path, bytes).map_err(|e| format!("임시 파일 쓰기 실패: {e}"))?;
    if let Some(replaced) = state.fonts.lock().unwrap().insert(slot, path) {
        let _ = std::fs::remove_file(replaced);
    }
    Ok(())
}

/// A·B 슬롯을 맞바꾼다 — "누가 라틴을 이기나" 스왑 (4a)
#[tauri::command]
fn swap_fonts(state: State<'_, AppState>) -> Result<(), String> {
    let mut fonts = state.fonts.lock().unwrap();
    let a = fonts.remove("a");
    let b = fonts.remove("b");
    if let Some(b) = b {
        fonts.insert("a".to_string(), b);
    }
    if let Some(a) = a {
        fonts.insert("b".to_string(), a);
    }
    Ok(())
}

/// 프론트 캐시 히트로 복원된 병합 결과를 export 대상과 동기화한다 (4b)
#[tauri::command]
fn set_merged(request: Request<'_>, state: State<'_, AppState>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("바이너리 본문이 필요합니다".into());
    };
    *state.last_merged.lock().unwrap() = Some(bytes.clone());
    Ok(())
}

/// 현재 미리보기 중인 병합 결과를 지정 경로에 저장한다 (4d)
#[tauri::command]
fn export_merged(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.last_merged.lock().unwrap();
    let bytes = guard.as_ref().ok_or("저장할 병합 결과가 없습니다")?;
    std::fs::write(&path, bytes).map_err(|e| format!("저장 실패: {e}"))?;
    Ok(())
}

/// 업로드된 A·B를 사이드카로 병합하고 결과 TTF 바이트를 그대로(raw IPC) 반환한다.
#[tauri::command]
async fn merge_fonts(app: AppHandle, name: String, base: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();

        let (font_a, font_b) = {
            let fonts = state.fonts.lock().unwrap();
            (fonts.get("a").cloned(), fonts.get("b").cloned())
        };
        let (font_a, font_b) = match (font_a, font_b) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err("A·B 두 폰트를 모두 올려야 합니다".to_string()),
        };

        let seq = state.seq.fetch_add(1, Ordering::Relaxed);
        let out = state.work_dir.join(format!("merged_{seq}.ttf"));

        let resp = sidecar_call(
            &state,
            json!({
                "cmd": "merge",
                "font_a": font_a.to_string_lossy(),
                "font_b": font_b.to_string_lossy(),
                "output": out.to_string_lossy(),
                "name": name,
                "base": base,
            }),
        )?;
        if resp.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(resp
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("알 수 없는 병합 오류")
                .to_string());
        }

        let bytes = std::fs::read(&out).map_err(|e| format!("병합 결과 읽기 실패: {e}"))?;
        let _ = std::fs::remove_file(&out);
        *state.last_merged.lock().unwrap() = Some(bytes.clone());
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 개발 단계: 저장소 루트의 scripts/ (Phase 5에서 번들 리소스로 교체)
            let scripts_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("src-tauri has parent")
                .join("scripts");
            let work_dir = std::env::temp_dir().join("font-moeum");
            std::fs::create_dir_all(&work_dir)?;

            app.manage(AppState {
                sidecar: Mutex::new(None),
                fonts: Mutex::new(HashMap::new()),
                last_merged: Mutex::new(None),
                scripts_dir,
                work_dir,
                seq: AtomicU64::new(0),
            });

            // 콜드 스타트 선지불: 백그라운드에서 사이드카를 미리 띄워 fonttools import까지 끝내둔다
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<AppState>();
                match sidecar_call(&state, json!({"cmd": "ping"})) {
                    Ok(v) => println!(
                        "sidecar ready (fonttools {})",
                        v.get("fonttools").and_then(Value::as_str).unwrap_or("?")
                    ),
                    Err(e) => eprintln!("sidecar warmup failed: {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            upload_font,
            merge_fonts,
            swap_fonts,
            set_merged,
            export_merged
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // 사이드카 고아 프로세스 방지
                let state = app.state::<AppState>();
                let sidecar = state.sidecar.lock().unwrap().take();
                if let Some(mut s) = sidecar {
                    let _ = writeln!(s.stdin, "{}", json!({"cmd": "quit"}));
                    let _ = s.stdin.flush();
                    let _ = s.child.wait();
                }
            }
        });
}
