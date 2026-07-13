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
                "병합 엔진(Python)이 없습니다: {} — scripts/에서 `uv sync`를 실행하세요",
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
            .map_err(|e| format!("병합 엔진 실행 실패: {e}"))?;
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
            .map_err(|e| format!("병합 엔진에 요청을 보내지 못했습니다: {e}"))?;

        let mut resp = String::new();
        let n = self
            .stdout
            .read_line(&mut resp)
            .map_err(|e| format!("병합 엔진 응답을 받지 못했습니다: {e}"))?;
        if n == 0 {
            return Err("병합 엔진이 예기치 않게 종료되었습니다 — 다시 병합해 보세요".into());
        }
        serde_json::from_str(&resp).map_err(|e| format!("병합 엔진 응답 파싱 실패: {e} — {resp}"))
    }
}

struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
    /// 프론트에서 업로드한 슬롯별 폰트의 임시 파일 경로 ("a" | "b")
    fonts: Mutex<HashMap<String, PathBuf>>,
    /// 마지막(현재 미리보기 중인) 병합 결과 — export 대상
    last_merged: Mutex<Option<Vec<u8>>>,
    /// 마지막 병합의 사이드카 stats (mode별 통계) — UI 조회용
    last_stats: Mutex<Option<Value>>,
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
        return Err(format!("내부 오류: 잘못된 슬롯 '{slot}' — 파일을 다시 올려보세요"));
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("내부 오류: 폰트 데이터가 전달되지 않았습니다 — 파일을 다시 올려보세요".into());
    };
    // 슬롯 고정 파일명을 쓰면 스왑 후 재업로드가 반대 슬롯 파일을 덮어쓴다 — 항상 유니크하게
    let n = state.seq.fetch_add(1, Ordering::Relaxed);
    let path = state.work_dir.join(format!("upload_{n}.ttf"));
    std::fs::write(&path, bytes).map_err(|e| format!("임시 파일 쓰기 실패: {e}"))?;
    if let Some(replaced) = state.fonts.lock().unwrap().insert(slot, path) {
        // OTF 변환 캐시(.ttfcache/.meta)도 함께 청소 — 신원 검사 덕에 남아도 무해하지만
        // %TEMP%에 쓰레기를 쌓지 않는다
        let mut cache = replaced.clone().into_os_string();
        cache.push(".ttfcache");
        let mut meta = cache.clone();
        meta.push(".meta");
        let _ = std::fs::remove_file(&cache);
        let _ = std::fs::remove_file(meta);
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
        return Err("내부 오류: 병합 데이터가 전달되지 않았습니다 — 다시 병합해 보세요".into());
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
/// `options`는 사이드카 merge 요청에 그대로 passthrough되는 JSON object
/// (mode/name/base/style/korean_scale/... 등 엔진별 옵션) — 예약 키
/// (cmd/font_a/font_b/output)는 프론트가 보내도 무시되고 서버 값으로 덮인다.
#[tauri::command]
async fn merge_fonts(app: AppHandle, options: Value) -> Result<Response, String> {
    let mut req = options
        .as_object()
        .cloned()
        .ok_or("병합 옵션이 올바르지 않습니다".to_string())?;

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

        // 예약 키는 프론트 옵션을 덮어써 마지막에 넣는다 — 임의의 cmd/경로 주입 방지
        req.insert("cmd".into(), json!("merge"));
        req.insert("font_a".into(), json!(font_a.to_string_lossy()));
        req.insert("font_b".into(), json!(font_b.to_string_lossy()));
        req.insert("output".into(), json!(out.to_string_lossy()));

        let resp = sidecar_call(&state, Value::Object(req))?;
        if resp.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(resp
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("알 수 없는 병합 오류")
                .to_string());
        }

        *state.last_stats.lock().unwrap() = Some(resp.get("stats").cloned().unwrap_or(Value::Null));

        let bytes = std::fs::read(&out).map_err(|e| format!("병합 결과 읽기 실패: {e}"))?;
        let _ = std::fs::remove_file(&out);
        *state.last_merged.lock().unwrap() = Some(bytes.clone());
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 마지막 병합의 사이드카 stats를 그대로 돌려준다 (없으면 null)
#[tauri::command]
fn get_merge_stats(state: State<'_, AppState>) -> Option<Value> {
    state.last_stats.lock().unwrap().clone()
}

/// 업로드된 슬롯 폰트의 고정폭 여부를 사이드카로 판정한다 — mono 엔진의
/// check_monospace와 같은 코드로 답해 UI 배지와 병합 시 검증이 어긋나지 않는다.
#[tauri::command]
async fn inspect_font(app: AppHandle, slot: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = state
            .fonts
            .lock()
            .unwrap()
            .get(&slot)
            .cloned()
            .ok_or_else(|| format!("슬롯 '{slot}'에 업로드된 폰트가 없습니다"))?;
        sidecar_call(&state, json!({"cmd": "inspect", "path": path.to_string_lossy()}))
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
                last_stats: Mutex::new(None),
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
            get_merge_stats,
            inspect_font,
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
