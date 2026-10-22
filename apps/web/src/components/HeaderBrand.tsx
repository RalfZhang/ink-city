import Brand from "./Brand";

/**
 * The name in the top corner of every page, as a site's header has it: fixed, so it
 * stays put while the pages scroll under it, and a way back to the first page.
 */
export default function HeaderBrand({ onHome }: { onHome: () => void }) {
  return (
    <a
      href="/"
      className="header-brand"
      aria-label="InkCity"
      onClick={(e) => {
        e.preventDefault();
        onHome();
      }}
    >
      <Brand size="header" />
    </a>
  );
}
