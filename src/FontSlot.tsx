import { useRef, useState } from "react";
import type { SlotId, LoadedFont, AxisLocation } from "./types";
import { instanceChoices, normalizeLocation, selectedChoice } from "./variable";

// 드래그/드롭/클릭 TTF/OTF 슬롯 타일 — 로컬 dragOver 상태와 input ref만 소유하는 순수 표현
// 컴포넌트. 실제 로딩 로직(onFile→loadFontFile)은 App에 남는다.
export function FontSlot({
  slot,
  info,
  font,
  error,
  instance,
  onFile,
  onInstanceChange,
}: {
  slot: SlotId;
  info: { title: string; desc: string; role: string };
  font: LoadedFont | null;
  error: string | null;
  instance: AxisLocation | null; // 가변 폰트의 고정 좌표 (null = 축 기본값)
  onFile: (file: File) => void;
  onInstanceChange: (loc: AxisLocation | null) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 로드됨 = 폰트가 있고 에러가 없을 때만. 에러가 나면 빈/에러 레이아웃으로 돌아가 붉은 문구를 보인다.
  const loaded = font !== null && !error;
  const variable = loaded ? font.variable : undefined;
  const choices = variable ? instanceChoices(variable) : [];

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
        // 로드됨: 슬림 행 — A/B 배지 + 모노 파일명 + 역할·upem (+ 가변 폰트면 인스턴스 선택)
        <>
          <div className="slot-row">
            <span className="slot-badge">{slot.toUpperCase()}</span>
            <div className="slot-row-text">
              <div className="slot-file">{font.fileName}</div>
              <div className="slot-desc">{`${info.role} · upem ${font.upem ?? "—"}`}</div>
            </div>
            {font.convertedFromOtf && (
              <span
                className="slot-conv"
                title="OTF(CFF) 입력 — 병합 시 TTF로 변환됩니다. 곡선 근사(cu2qu)로 미세한 윤곽 차이가 있고 CFF 힌팅은 사라집니다. 출력은 항상 TTF."
              >
                OTF→TTF
              </span>
            )}
          </div>
          {variable && (
            // 슬롯 클릭 = 파일 선택이므로 드롭다운 클릭이 버블링되지 않게 막는다
            <label
              className="slot-var"
              onClick={(e) => e.stopPropagation()}
              title="가변 폰트 — 고른 인스턴스로 고정해 병합합니다(미리보기는 병합 후 반영). 가변 축은 결과물에 남지 않습니다."
            >
              <span className="slot-var-label">가변</span>
              <select
                className="select-input slot-var-select"
                value={Math.max(0, selectedChoice(instance, variable, choices))}
                onChange={(e) => {
                  const choice = choices[Number(e.currentTarget.value)];
                  if (choice) onInstanceChange(normalizeLocation(choice.location, variable));
                }}
              >
                {choices.map((c, i) => (
                  <option key={i} value={i}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      ) : (
        // 빈/에러: 드롭 유도(점선 타일)
        <>
          <div className="slot-title">{info.title}</div>
          <div className="slot-file">{error ?? "TTF/OTF 드래그 또는 클릭"}</div>
          <div className="slot-desc">{info.desc}</div>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".ttf,.otf"
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
