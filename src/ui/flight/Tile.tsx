import "./Tile.css";

interface TileProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  accent?: "cyan" | "green" | "yellow";
  wide?: boolean;
  testId: string;
}

export default function Tile({
  label,
  value,
  icon,
  accent,
  wide,
  testId,
}: TileProps) {
  const classes = [
    "tile",
    accent,
    wide ? "wide" : undefined,
    icon ? "has-icon" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <div className="label">{label}</div>
      <div className="value" data-testid={testId}>
        {value}
      </div>
      {icon && <div className="tile-icon">{icon}</div>}
    </div>
  );
}
