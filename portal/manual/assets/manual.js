// 说明书站点交互：窄屏目录抽屉开合与当前页定位、右侧「本页目录」滚动高亮。无外部请求。
(function () {
  "use strict";

  var toggle = document.querySelector(".nav-toggle");
  var drawer = document.getElementById("manual-nav");

  if (toggle && drawer) {
    // 抽屉内容 33 项远超一屏，跨页跳转会把 scrollTop 重置为 0，
    // 于是翻到列表末尾的页面时抽屉停在第一组，看着像「自动跳回第一个」。
    // 打开时把当前页滚到可视区中部，位置由 build.mjs 注入的 a.is-current 决定。
    var revealCurrent = function () {
      var current = drawer.querySelector("a.is-current");
      if (!current) return;
      var max = drawer.scrollHeight - drawer.clientHeight;
      var target = current.offsetTop - drawer.clientHeight / 2 + current.offsetHeight / 2;
      drawer.scrollTop = Math.max(0, Math.min(target, max));
    };

    toggle.addEventListener("click", function () {
      var open = drawer.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      // display 从 none 变 block 后才有 clientHeight，定位必须等一帧。
      if (open) requestAnimationFrame(revealCurrent);
    });

    // 窄屏下点抽屉里的链接跳转后自动收起，避免遮住正文。
    drawer.addEventListener("click", function (event) {
      if (event.target && event.target.tagName === "A") {
        drawer.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // 右侧「本页目录」：滚动时把视口内最近的标题高亮出来。
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc-rail a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var linkById = {};
    tocLinks.forEach(function (link) {
      linkById[link.getAttribute("href").slice(1)] = link;
    });
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var link = linkById[entry.target.id];
          if (!link) return;
          tocLinks.forEach(function (other) {
            other.classList.remove("is-active");
          });
          link.classList.add("is-active");
        });
      },
      { rootMargin: "-70px 0px -65% 0px" }
    );
    Object.keys(linkById).forEach(function (id) {
      var heading = document.getElementById(id);
      if (heading) observer.observe(heading);
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
