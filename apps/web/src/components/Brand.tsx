import { cn } from "@inkcity/ui/lib/utils";
import logo from "../assets/logo.svg";

/**
 * The README's logo (../assets/logo.svg) with "InkCity": stacked, the mark above
 * the name, at the head of the sheet (./Sheet.tsx); side by side, as a site's
 * header has them, in the page's top corner (./HeaderBrand.tsx).
 */
export default function Brand({ size, className }: { size: "large" | "header"; className?: string }) {
  return (
    <div className={cn("brand", `brand--${size}`, className)}>
      <img src={logo} alt="" className="brand__logo" />
      <span className="brand__name">InkCity</span>
    </div>
  );
}
