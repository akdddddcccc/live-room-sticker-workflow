import { computed, reactive } from "vue";
import AIWorkflowDemo from "./components/AIWorkflowDemo.js";

function getLang() {
  const hashLang = window.location.hash.replace(/^#\/?/, "").split("/")[0];
  return hashLang === "en" ? "en" : "zh";
}

export default {
  name: "App",
  components: {
    AIWorkflowDemo
  },
  setup() {
    const state = reactive({ lang: getLang() });

    window.addEventListener("hashchange", () => {
      state.lang = getLang();
    });

    const title = computed(() => (
      "AI直播间贴片生成项目"
    ));

    return {
      state,
      title
    };
  },
  template: `
    <main class="standalone-workflow-shell">
      <header class="standalone-workflow-header">
        <div>
          <p>NOBOOK</p>
          <h1>{{ title }}</h1>
        </div>
        <nav aria-label="Language">
          <a href="#/zh" :class="{ active: state.lang === 'zh' }">中文</a>
          <a href="#/en" :class="{ active: state.lang === 'en' }">EN</a>
        </nav>
      </header>
      <AIWorkflowDemo :lang="state.lang" />
    </main>
  `
};
