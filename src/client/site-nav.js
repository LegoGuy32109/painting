// @ts-check

class SiteNav extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    const current = location.pathname === "/" ? "/" : location.pathname
      .replace(/\.html$/, "");
    const links = [
      ["/", "Home"],
      ["/editor", "Paint"],
      ["/collection", "Collection"],
      ["/display", "Display"],
    ];
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Primary navigation");
    const brand = document.createElement("a");
    brand.className = "brand";
    brand.href = "/";
    brand.textContent = "Joy of Painting";
    const list = document.createElement("div");
    list.className = "links";
    for (const [href, label] of links) {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = label;
      if (current === href) link.setAttribute("aria-current", "page");
      list.append(link);
    }
    nav.append(brand, list);
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; position:relative; z-index:20; }
      nav { display:flex; align-items:center; justify-content:space-between; gap:1rem; width:min(100% - 2rem,72rem); min-height:4rem; margin:auto; padding:max(.5rem,env(safe-area-inset-top)) 0 .5rem; }
      a { color:inherit; text-decoration:none; }
      .brand { font-size:clamp(.75rem,2.5vw,1rem); white-space:nowrap; }
      .links { display:flex; align-items:center; justify-content:flex-end; gap:clamp(.35rem,2vw,1rem); font-family:ui-monospace,monospace; font-size:clamp(.72rem,2.4vw,.9rem); }
      .links a { padding:.5rem .25rem; border-bottom:.1875rem solid transparent; }
      .links a[aria-current="page"] { border-color:var(--mc-blue,#3c44aa); }
      a:focus-visible { outline:.1875rem solid var(--mc-blue,#3c44aa); outline-offset:.125rem; }
      @media (max-width:34rem) { nav { align-items:flex-start; flex-direction:column; gap:.2rem; padding-bottom:.75rem; } .links { width:100%; justify-content:space-between; } }
    `;
    root.append(style, nav);
  }
}

customElements.define("site-nav", SiteNav);
