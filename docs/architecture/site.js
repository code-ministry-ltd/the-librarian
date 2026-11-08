/* global document, location, addEventListener */
// Opens the matching <details> content in a modal; without JS, the link jumps to it.
const modal = document.getElementById("why-modal");
document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-why]");
  if (!link) return;
  const source = document.getElementById(link.dataset.why);
  if (!source || source.tagName !== "DETAILS") return;
  event.preventDefault();
  const body = document.getElementById("why-body");
  body.replaceChildren(
    ...[...source.children]
      .filter((el) => el.tagName !== "SUMMARY")
      .map((el) => el.cloneNode(true)),
  );
  modal.setAttribute("aria-label", source.querySelector("summary").textContent);
  modal.showModal();
});
function openFromHash() {
  let id = location.hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    return;
  }
  const target = document.getElementById(id);
  if (target && target.tagName === "DETAILS") target.open = true;
}
addEventListener("hashchange", openFromHash);
openFromHash();
const closed = new Set();
addEventListener("beforeprint", () =>
  document.querySelectorAll("details").forEach((d) => {
    if (!d.open) {
      closed.add(d);
      d.open = true;
    }
  }),
);
addEventListener("afterprint", () => {
  closed.forEach((d) => {
    d.open = false;
  });
  closed.clear();
});
