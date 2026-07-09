import { useRef, useState } from "react";
import type { SlotId, LoadedFont } from "./types";

// 드래그/드롭/클릭 TTF 슬롯 타일 — 로컬 dragOver 상태와 input ref만 소유하는 순수 표현
// 컴포넌트. 실제 로딩 로직(onFile→loadFontFile)은 App에 남는다.
export function FontSlot({
  slot,
  info,
  font,
  error,
  onFile,
}: {
  slot: SlotId;
  info: { title: string; desc: string; role: string };
  font: LoadedFont | null;
  error: string | null;
  onFile: (file: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 로드됨 = 폰트가 있고 에러가 없을 때만. 에러가 나면 빈/에러 레이아웃으로 돌아가 붉은 문구를 보인다.
  const loaded = font !== null && !error;

  return (
    <div
      className={
        `slot slot-${slot}` +
        (dragOver ? " slot-dragover" : "") +
        (error ? " slot-error" : "") +
        (loaded ? " slot-loaded" : "")
      }
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      {loaded ? (
        // 로드됨: 슬림 행 — A/B 배지 + 모노 파일명 + 역할·upem
        <div className="slot-row">
          <span className="slot-badge">{slot.toUpperCase()}</span>
          <div className="slot-row-text">
            <div className="slot-file">{font.fileName}</div>
            <div className="slot-desc">{`${info.role} · upem ${font.upem ?? "—"}`}</div>
          </div>
        </div>
      ) : (
        // 빈/에러: 드롭 유도(점선 타일)
        <>
          <div className="slot-title">{info.title}</div>
          <div className="slot-file">{error ?? "TTF 드래그 또는 클릭"}</div>
          <div className="slot-desc">{info.desc}</div>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".ttf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
    </div>
  );
}
