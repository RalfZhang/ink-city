import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

// A settings/section row: label (with optional sub-description) on the left, an
// optional control on the right. Shared across the General / Style / About tabs
// so the layout stays identical everywhere. `description` accepts rich content
// (it's wrapped in a <div>, not a <p>, so it can hold its own paragraphs/links),
// and `control` is optional for label-only / description-only rows.
export default function SettingRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <Label className="text-sm">{label}</Label>
        {description && (
          <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
        )}
      </div>
      {control}
    </div>
  );
}
