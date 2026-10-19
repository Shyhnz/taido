import type { SubjectColor } from "../../bindings";
import { subjectColorVar } from "../../lib/format";

export function ColorSwatch({
  color,
  size = 12,
}: {
  color: SubjectColor;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: subjectColorVar(color),
      }}
    />
  );
}
