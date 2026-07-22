/**
 * One in-flight stat in the pane's readout row. Shared by the playback
 * dock and the clip dock, styled by ReplayDock.css.
 */
export default function Readout({
  label,
  value,
  accent,
  testId,
}: {
  label: string;
  value: string;
  accent?: "cyan" | "green" | "yellow";
  testId: string;
}) {
  return (
    <div className={accent ? `replay-readout ${accent}` : "replay-readout"}>
      <div className="label">{label}</div>
      <div className="value" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
