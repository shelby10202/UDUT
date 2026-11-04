// Aplica o tema (claro/escuro) antes de pintar a página: o salvo pela pessoa ou o do sistema.
(function () {
  var tema = null;
  try { tema = localStorage.getItem("tema"); } catch (e) { /* sem armazenamento */ }
  if (tema !== "dark" && tema !== "light") {
    tema = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", tema);
  document.documentElement.classList.add("js");
})();
