// 说明书站点交互：仅两件事——窄屏目录开合、回到顶部。无外部请求。
(function () {
  "use strict";

  var toggle = document.querySelector(".nav-toggle");
  var aside = document.getElementById("manual-nav");

  if (toggle && aside) {
    toggle.addEventListener("click", function () {
      var open = aside.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // 窄屏下点目录跳转后自动收起，避免遮住正文。
    aside.addEventListener("click", function (event) {
      if (event.target && event.target.tagName === "A" && window.innerWidth <= 900) {
        aside.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  var toTop = document.querySelector(".to-top");
  if (toTop) {
    var onScroll = function () {
      toTop.classList.toggle("is-visible", window.scrollY > 400);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    toTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
})();
