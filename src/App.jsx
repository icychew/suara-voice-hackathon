import { useEffect, useState } from "react";
import { normalizeInterfaceLocale, readInterfaceLocale, withInterfaceLocale } from "./locale.js";

const LOCALES = [
  { id: "ms", label: "BM" },
  { id: "en", label: "EN" },
  { id: "zh", label: "中文" },
];

const COPY = {
  en: {
    homeLabel: "Suara home",
    navigationLabel: "Primary navigation",
    skip: "Skip to content",
    localeLabel: "Choose interface language",
    voiceCta: "Try the voice pilot",
    voiceNote: "Private judge access code required",
    nav: [
      ["How it works", "#how"],
      ["Trust", "#trust"],
      ["Languages", "#languages"],
      ["Research", "#research"],
    ],
    cta: "Explore the synthetic demo",
    heroTitle: "Every life deserves to be heard in their own words.",
    heroBody:
      "Suara shows how reviewed conversations can become evidence-linked memoir drafts — across Bahasa Malaysia, English and Simplified Chinese.",
    heroSafety: "Synthetic demonstration only. Real-family intake is not open.",
    heroLink: "See how the workflow works",
    imageAlt:
      "An AI-generated multigenerational Malaysian family looking through a photo album together",
    imageNote: "AI-generated, non-identifiable visual. No family material used.",
    workflowKicker: "A visible workflow",
    workflowTitle: "A careful path from consent to integrity",
    workflowBody:
      "Each stage stays separate and reviewable. A completed draft is not the same as family approval or publication.",
    steps: [
      ["01", "Listen", "Consent comes first", "Purpose and permitted uses are recorded before any processing begins."],
      ["02", "Review", "Review every word", "A candidate transcript remains unapproved until a human checks each segment."],
      ["03", "Shape", "Link every claim", "Story claims and chapters point back to approved evidence spans."],
      ["04", "Approve", "Verify the lineage", "A bounded report checks the path without exposing the story itself."],
    ],
    demoKicker: "Read-only synthetic walkthrough",
    demoTitle: "See what the pipeline reveals — and what it keeps private",
    demoBody:
      "Choose a stage to inspect a safe, fixed example. This synthetic walkthrough has no uploads, text fields, accounts or writable endpoints.",
    stageLabel: "Pipeline stages",
    sampleLabel: "Synthetic example",
    humanGate: "Human gate",
    required: "Required",
    notRequired: "Not required at this step",
    boundariesLabel: "Public boundary",
    boundaries: ["No transcript or memoir prose", "No names, files or speaker details", "No model secrets or tokens"],
    statuses: {
      complete: "Complete",
      review: "Needs human review",
      ready: "Ready",
      pending: "Pending",
      blocked: "Release blocked",
    },
    stages: [
      ["consent_gate", "Consent", "complete", false, "Purpose-specific consent recorded for a synthetic narrator."],
      ["audio_intake", "Audio intake", "complete", false, "Playable generated narration with timed fictional excerpts; no human recording or upload."],
      ["speech_routing", "Speech route", "complete", false, "Declared Malaysian language route with a human-first boundary."],
      ["asr_candidate", "Candidate transcript", "complete", false, "Mock machine output; never treated as approved evidence."],
      ["human_review", "Human review", "review", true, "Segment-by-segment review is mandatory before evidence can be used."],
      ["grounded_story", "Grounded story", "ready", true, "Every claim must point to an approved source span."],
      ["memoir_draft", "Memoir draft", "pending", true, "A draft may be complete while family approval remains pending."],
      ["integrity_verification", "Integrity check", "blocked", true, "Local lineage can be checked, but publication and release stay blocked."],
    ],
    trustKicker: "Trust and provenance",
    trustTitle: "Built around consent, evidence and human judgment",
    trustBody:
      "Machine output is a candidate, never an approved family record. Consent, review, evidence approval and release remain distinct decisions.",
    trustItems: [
      ["Scoped consent", "Permission for one purpose does not automatically grant permission for another. Withdrawal freezes new processing."],
      ["Evidence before prose", "Every story claim requires an approved source span, and chapter links remain visible for review."],
      ["Human review", "People approve the transcript, the selected evidence and the memoir draft at separate gates."],
      ["No silent release", "Phase-0 drafts cannot be exported, shared, published or used for voice cloning."],
    ],
    languagesKicker: "Malaysia, three interface languages",
    languagesTitle: "One workflow. Three clear language lanes.",
    languagesBody:
      "Interface language, spoken language and document language remain separate, so one choice never silently determines another.",
    languageItems: [
      ["Bahasa Malaysia", "ms-MY", "Interface ready", "Text research ready; Malaysian older-adult speech benchmark still missing."],
      ["English", "en-MY", "Interface ready", "US-English text is only a proxy; Malaysian-English speech remains metadata-only."],
      ["简体中文", "zh-Hans-MY", "界面就绪", "Mainland-Mandarin text is only a proxy; Malaysian-Mandarin speech remains metadata-only."],
    ],
    researchKicker: "Public-data R&D snapshot",
    researchTitle: "Research data stays separate from family stories",
    researchBody:
      "The packaged snapshot tracks six reviewed sources and a planned text-only evaluation pack. Public text readiness does not authorize family-data use or acoustic benchmarking.",
    stats: [
      ["6", "Sources in the reviewed registry"],
      ["400", "Planned text-only research cases"],
      ["0", "Public-audio datasets approved for benchmarking"],
    ],
    researchNote:
      "US-English and mainland-Mandarin text remain research proxies, not Malaysian validation. No public audio is approved.",
    closeTitle: "Explore the workflow without family data.",
    closeBody:
      "This public walkthrough is deliberately immutable. It explains the consent-to-integrity path without collecting names, recordings or personal information.",
    closeButton: "Open the synthetic walkthrough",
    footerTag: "Consent-led oral-history research for Malaysia.",
    footerStatus: "Phase-0 synthetic demonstration. No real-family intake, publication or model-training availability.",
    backTop: "Back to top",
  },
  ms: {
    homeLabel: "Laman utama Suara",
    navigationLabel: "Navigasi utama",
    skip: "Langkau ke kandungan",
    localeLabel: "Pilih bahasa antara muka",
    voiceCta: "Cuba rintis suara",
    voiceNote: "Kod akses juri peribadi diperlukan",
    nav: [["Cara ia berfungsi", "#how"], ["Kepercayaan", "#trust"], ["Bahasa", "#languages"], ["Penyelidikan", "#research"]],
    cta: "Terokai demo sintetik",
    heroTitle: "Setiap kisah hidup wajar didengar dengan kata-kata mereka sendiri.",
    heroBody:
      "Suara menunjukkan bagaimana perbualan yang telah disemak boleh menjadi draf memoir berpaut bukti — dalam Bahasa Malaysia, bahasa Inggeris dan bahasa Cina Ringkas.",
    heroSafety: "Demonstrasi sintetik sahaja. Pengambilan data keluarga sebenar belum dibuka.",
    heroLink: "Lihat cara aliran kerja berfungsi",
    imageAlt: "Visual janaan AI sebuah keluarga Malaysia berbilang generasi melihat album foto bersama",
    imageNote: "Visual janaan AI tanpa identiti. Tiada bahan keluarga digunakan.",
    workflowKicker: "Aliran kerja yang telus",
    workflowTitle: "Laluan berhati-hati daripada persetujuan hingga integriti",
    workflowBody:
      "Setiap peringkat kekal berasingan dan boleh disemak. Draf yang siap bukan bermaksud keluarga telah meluluskan penerbitan.",
    steps: [
      ["01", "Dengar", "Persetujuan didahulukan", "Tujuan dan penggunaan yang dibenarkan direkod sebelum pemprosesan bermula."],
      ["02", "Semak", "Semak setiap perkataan", "Transkrip calon belum diluluskan sehingga setiap segmen diperiksa manusia."],
      ["03", "Bentuk", "Pautkan setiap dakwaan", "Dakwaan cerita dan bab merujuk kembali kepada petikan bukti yang diluluskan."],
      ["04", "Lulus", "Sahkan rantaian", "Laporan terhad menyemak aliran tanpa mendedahkan cerita itu sendiri."],
    ],
    demoKicker: "Panduan sintetik baca sahaja",
    demoTitle: "Lihat perkara yang ditunjukkan saluran — dan yang kekal peribadi",
    demoBody:
      "Pilih satu peringkat untuk melihat contoh tetap yang selamat. Panduan sintetik ini tiada muat naik, medan teks, akaun atau titik akhir boleh tulis.",
    stageLabel: "Peringkat saluran",
    sampleLabel: "Contoh sintetik",
    humanGate: "Gerbang manusia",
    required: "Diperlukan",
    notRequired: "Tidak diperlukan pada peringkat ini",
    boundariesLabel: "Sempadan awam",
    boundaries: ["Tiada prosa transkrip atau memoir", "Tiada nama, fail atau butiran penutur", "Tiada rahsia model atau token"],
    statuses: { complete: "Selesai", review: "Perlu semakan manusia", ready: "Sedia", pending: "Menunggu", blocked: "Pelepasan disekat" },
    stages: [
      ["consent_gate", "Persetujuan", "complete", false, "Persetujuan khusus tujuan direkod untuk pencerita sintetik."],
      ["audio_intake", "Penerimaan audio", "complete", false, "Narasi janaan boleh dimainkan dengan petikan rekaan bermasa; tiada rakaman manusia atau muat naik."],
      ["speech_routing", "Laluan pertuturan", "complete", false, "Laluan bahasa Malaysia diisytihar dengan sempadan manusia dahulu."],
      ["asr_candidate", "Transkrip calon", "complete", false, "Output mesin olok-olok; tidak pernah dianggap bukti diluluskan."],
      ["human_review", "Semakan manusia", "review", true, "Semakan setiap segmen wajib sebelum bukti boleh digunakan."],
      ["grounded_story", "Cerita berpaut bukti", "ready", true, "Setiap dakwaan mesti menunjuk kepada petikan sumber yang diluluskan."],
      ["memoir_draft", "Draf memoir", "pending", true, "Draf boleh siap sementara kelulusan keluarga masih menunggu."],
      ["integrity_verification", "Semakan integriti", "blocked", true, "Rantaian tempatan boleh disemak, tetapi penerbitan dan pelepasan kekal disekat."],
    ],
    trustKicker: "Kepercayaan dan asal-usul",
    trustTitle: "Dibina berasaskan persetujuan, bukti dan pertimbangan manusia",
    trustBody:
      "Output mesin ialah calon, bukan rekod keluarga yang diluluskan. Persetujuan, semakan, kelulusan bukti dan pelepasan kekal sebagai keputusan berasingan.",
    trustItems: [
      ["Persetujuan terhad", "Kebenaran bagi satu tujuan tidak memberi kebenaran automatik untuk tujuan lain. Penarikan balik menghentikan pemprosesan baharu."],
      ["Bukti sebelum prosa", "Setiap dakwaan cerita memerlukan petikan sumber yang diluluskan dan pautan bab kekal kelihatan untuk semakan."],
      ["Semakan manusia", "Manusia meluluskan transkrip, bukti terpilih dan draf memoir pada gerbang berasingan."],
      ["Tiada pelepasan senyap", "Draf Fasa-0 tidak boleh dieksport, dikongsi, diterbitkan atau digunakan untuk pengklonan suara."],
    ],
    languagesKicker: "Malaysia, tiga bahasa antara muka",
    languagesTitle: "Satu aliran kerja. Tiga laluan bahasa yang jelas.",
    languagesBody:
      "Bahasa antara muka, bahasa pertuturan dan bahasa dokumen kekal berasingan supaya satu pilihan tidak menentukan yang lain secara senyap.",
    languageItems: [
      ["Bahasa Malaysia", "ms-MY", "Antara muka sedia", "Penyelidikan teks sedia; penanda aras pertuturan warga emas Malaysia masih belum ada."],
      ["English", "en-MY", "Interface ready", "Teks AS hanyalah proksi; pertuturan Inggeris Malaysia masih pada metadata sahaja."],
      ["简体中文", "zh-Hans-MY", "界面就绪", "Teks Mandarin tanah besar hanyalah proksi; pertuturan Mandarin Malaysia masih pada metadata sahaja."],
    ],
    researchKicker: "Gambaran R&D data awam",
    researchTitle: "Data penyelidikan kekal berasingan daripada kisah keluarga",
    researchBody:
      "Gambaran terkunci menjejaki enam sumber disemak dan pek penilaian teks sahaja yang dirancang. Kesediaan teks awam tidak membenarkan penggunaan data keluarga atau penanda aras akustik.",
    stats: [["6", "Sumber dalam daftar disemak"], ["400", "Kes penyelidikan teks sahaja yang dirancang"], ["0", "Set data audio awam diluluskan untuk penanda aras"]],
    researchNote:
      "Teks Inggeris AS dan Mandarin tanah besar kekal proksi penyelidikan, bukan pengesahan Malaysia. Tiada audio awam diluluskan.",
    closeTitle: "Terokai aliran kerja tanpa data keluarga.",
    closeBody:
      "Panduan awam ini sengaja tidak boleh diubah. Ia menerangkan laluan persetujuan hingga integriti tanpa mengumpul nama, rakaman atau maklumat peribadi.",
    closeButton: "Buka panduan sintetik",
    footerTag: "Penyelidikan sejarah lisan berasaskan persetujuan untuk Malaysia.",
    footerStatus: "Demonstrasi sintetik Fasa-0. Tiada pengambilan keluarga sebenar, penerbitan atau latihan model.",
    backTop: "Kembali ke atas",
  },
  zh: {
    homeLabel: "Suara 首页",
    navigationLabel: "主导航",
    skip: "跳至主要内容",
    localeLabel: "选择界面语言",
    voiceCta: "体验语音试点",
    voiceNote: "需要评审专用访问码",
    nav: [["运作方式", "#how"], ["信任原则", "#trust"], ["语言", "#languages"], ["研究", "#research"]],
    cta: "探索合成数据演示",
    heroTitle: "每段人生，都值得用自己的话被听见。",
    heroBody:
      "Suara 展示如何将经过人工复核的对话整理成带有证据链接的回忆录草稿，支持马来语、英语和简体中文。",
    heroSafety: "仅供合成数据演示。暂不接收真实家庭资料。",
    heroLink: "了解工作流程",
    imageAlt: "AI 生成的马来西亚多代家庭一起翻看相册的画面",
    imageNote: "AI 生成的非身份化视觉图。未使用任何家庭资料。",
    workflowKicker: "透明可见的流程",
    workflowTitle: "从同意授权到完整性验证的审慎路径",
    workflowBody: "每个阶段彼此独立并可复核。草稿完成并不代表家庭批准或同意发布。",
    steps: [
      ["01", "聆听", "先取得同意", "在任何处理开始前，记录目的与允许的用途。"],
      ["02", "复核", "逐字核对", "候选转录未经人工逐段确认前，不属于已批准内容。"],
      ["03", "整理", "每项陈述都有依据", "故事陈述和章节必须指向已批准的证据片段。"],
      ["04", "批准", "验证来源链", "受限报告检查流程状态，但不会公开故事内容。"],
    ],
    demoKicker: "只读合成数据演示",
    demoTitle: "查看流程公开什么，也了解它保护什么",
    demoBody: "选择一个阶段查看安全的固定示例。此合成数据演示没有上传、输入框、账户或可写接口。",
    stageLabel: "流程阶段",
    sampleLabel: "合成示例",
    humanGate: "人工关卡",
    required: "必须",
    notRequired: "本阶段不需要",
    boundariesLabel: "公开边界",
    boundaries: ["不公开转录或回忆录正文", "不公开姓名、文件或说话者资料", "不公开模型机密或令牌"],
    statuses: { complete: "已完成", review: "需要人工复核", ready: "已就绪", pending: "待处理", blocked: "禁止发布" },
    stages: [
      ["consent_gate", "同意授权", "complete", false, "已为合成叙述者记录特定用途的同意授权。"],
      ["audio_intake", "音频接收", "complete", false, "可播放的生成旁白及带时间的虚构片段；不使用真人录音或上传。"],
      ["speech_routing", "语音路线", "complete", false, "明确马来西亚语言路线，并设置人工优先边界。"],
      ["asr_candidate", "候选转录", "complete", false, "模拟机器输出，绝不视为已批准证据。"],
      ["human_review", "人工复核", "review", true, "证据使用前必须逐段进行人工复核。"],
      ["grounded_story", "证据支撑的故事", "ready", true, "每项陈述都必须指向已批准的来源片段。"],
      ["memoir_draft", "回忆录草稿", "pending", true, "草稿可以完成，但家庭批准仍可处于待定状态。"],
      ["integrity_verification", "完整性检查", "blocked", true, "可以检查本地来源链，但发布与对外开放仍被禁止。"],
    ],
    trustKicker: "信任与来源",
    trustTitle: "以同意、证据和人工判断为核心",
    trustBody: "机器输出只是候选内容，并非获批的家庭记录。同意、复核、证据批准和发布始终是独立决定。",
    trustItems: [
      ["限定用途的同意", "某一用途的许可不会自动扩展至其他用途。撤回同意后，新的处理会被冻结。"],
      ["先证据，后叙事", "每项故事陈述都需要已批准的来源片段，章节与证据的链接保留供复核。"],
      ["人工复核", "转录、证据选择和回忆录草稿分别经过人工关卡。"],
      ["不静默发布", "Phase-0 草稿不可导出、分享、出版，也不可用于声音克隆。"],
    ],
    languagesKicker: "面向马来西亚的三种界面语言",
    languagesTitle: "一个流程，三条清晰的语言路径。",
    languagesBody: "界面语言、口述语言与文档语言彼此独立，不会因一次选择而被自动绑定。",
    languageItems: [
      ["Bahasa Malaysia", "ms-MY", "界面就绪", "文本研究已就绪；仍缺少马来西亚年长者语音基准。"],
      ["English", "en-MY", "界面就绪", "美国英语文本仅为代理；马来西亚英语语音仍处于仅元数据状态。"],
      ["简体中文", "zh-Hans-MY", "界面就绪", "中国大陆普通话文本仅为代理；马来西亚华语语音仍处于仅元数据状态。"],
    ],
    researchKicker: "公共数据研发概况",
    researchTitle: "研究数据与家庭故事严格分离",
    researchBody: "当前锁定快照追踪六个已审核来源及计划中的纯文本评估集。公共文本可用不等于获准使用家庭数据或进行声学基准测试。",
    stats: [["6", "已审核登记册中的来源"], ["400", "计划中的纯文本研究案例"], ["0", "获准用于基准测试的公共音频数据集"]],
    researchNote: "美国英语与中国大陆普通话文本只是研究代理，并非马来西亚验证。当前没有公共音频获批。",
    closeTitle: "无需家庭数据，也能了解完整流程。",
    closeBody: "这个公开演示刻意保持不可写入，只说明从同意到完整性验证的路径，不收集姓名、录音或个人资料。",
    closeButton: "打开合成数据演示",
    footerTag: "为马来西亚而设、以同意为先的口述历史研究。",
    footerStatus: "Phase-0 合成数据演示。不接收真实家庭资料，不提供出版或模型训练。",
    backTop: "返回顶部",
  },
};

function ArrowIcon() {
  return <span aria-hidden="true">↗</span>;
}

function SectionIntro({ kicker, title, titleId, body, light = false }) {
  return (
    <div className={`section-intro${light ? " section-intro--light" : ""}`}>
      <p className="kicker">{kicker}</p>
      <h2 id={titleId}>{title}</h2>
      {body ? <p className="section-lede">{body}</p> : null}
    </div>
  );
}

function App() {
  const [locale, setLocale] = useState(() => readInterfaceLocale(window.location.search));
  const [activeStage, setActiveStage] = useState(0);
  const c = COPY[locale];
  const stage = c.stages[activeStage];
  const prototypeHref = withInterfaceLocale("/prototype/", locale);
  const voiceEntryRoute = __SUARA_VOICE_ENTRY_ROUTE__;
  const voiceEntryEnabled = typeof voiceEntryRoute === "string";
  const voiceHref = voiceEntryEnabled ? withInterfaceLocale(voiceEntryRoute, locale) : prototypeHref;

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-Hans" : locale;
  }, [locale]);

  const chooseLocale = (nextLocale) => {
    const safeLocale = normalizeInterfaceLocale(nextLocale);
    setLocale(safeLocale);
    window.history.replaceState(null, "", withInterfaceLocale(window.location.href, safeLocale));
  };

  return (
    <>
      <a className="skip-link" href="#main" onClick={() => document.getElementById("main")?.focus()}>{c.skip}</a>
      <header className="site-header" id="top">
        <a className="wordmark" href="#top" aria-label={c.homeLabel}>
          <span className="wordmark__pulse" aria-hidden="true" />
          Suara
        </a>
        <nav className="desktop-nav" aria-label={c.navigationLabel}>
          {c.nav.map(([label, href]) => <a href={href} key={href}>{label}</a>)}
        </nav>
        <div className="header-actions">
          <div className="locale-switcher" role="group" aria-label={c.localeLabel}>
            {LOCALES.map((item) => (
              <button
                aria-pressed={locale === item.id}
                className={locale === item.id ? "is-active" : ""}
                key={item.id}
                onClick={() => chooseLocale(item.id)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
          <a className="button button--small" href={voiceEntryEnabled ? voiceHref : prototypeHref}>
            {voiceEntryEnabled ? c.voiceCta : c.cta}
          </a>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="hero section-shell" aria-labelledby="hero-title">
          <div className="hero__copy">
            <h1 id="hero-title">{c.heroTitle}</h1>
            <p className="hero__lede">{c.heroBody}</p>
            <div className="hero__actions">
              <a className="button" href={voiceEntryEnabled ? voiceHref : prototypeHref}>
                {voiceEntryEnabled ? c.voiceCta : c.cta} <ArrowIcon />
              </a>
              <a className="text-link" href={voiceEntryEnabled ? prototypeHref : "#how"}>
                {voiceEntryEnabled ? c.cta : c.heroLink} <span aria-hidden="true">↓</span>
              </a>
            </div>
            {voiceEntryEnabled ? <p className="voice-entry-note">{c.voiceNote}</p> : null}
            <p className="safety-note"><span aria-hidden="true">●</span>{c.heroSafety}</p>
          </div>
          <figure className="hero__media">
            <img
              alt={c.imageAlt}
              decoding="async"
              fetchPriority="high"
              height="1024"
              src="/assets/hero-family-album.webp"
              width="1536"
            />
            <figcaption>{c.imageNote}</figcaption>
          </figure>
        </section>

        <section className="workflow section-shell section-block" id="how" aria-labelledby="workflow-title">
          <SectionIntro kicker={c.workflowKicker} title={c.workflowTitle} titleId="workflow-title" body={c.workflowBody} />
          <div className="workflow-grid">
            {c.steps.map(([number, verb, title, body]) => (
              <article className="workflow-step" key={number}>
                <div className="workflow-step__top"><span>{number}</span><strong>{verb}</strong></div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="demo section-block" id="demo" aria-labelledby="demo-title">
          <div className="section-shell">
            <SectionIntro kicker={c.demoKicker} title={c.demoTitle} titleId="demo-title" body={c.demoBody} light />
            <div className="demo-console">
              <div className="stage-list" role="tablist" aria-label={c.stageLabel}>
                {c.stages.map((item, index) => (
                  <button
                    aria-controls="stage-panel"
                    aria-selected={activeStage === index}
                    className={activeStage === index ? "is-active" : ""}
                    id={`stage-tab-${index}`}
                    key={item[0]}
                    onClick={() => setActiveStage(index)}
                    tabIndex={activeStage === index ? 0 : -1}
                    onKeyDown={(event) => {
                      const last = c.stages.length - 1;
                      const next = event.key === "Home" ? 0
                        : event.key === "End" ? last
                        : ["ArrowRight", "ArrowDown"].includes(event.key) ? (index + 1) % c.stages.length
                        : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (index + last) % c.stages.length
                        : null;
                      if (next === null) return;
                      event.preventDefault();
                      setActiveStage(next);
                      document.getElementById(`stage-tab-${next}`)?.focus();
                    }}
                    role="tab"
                    type="button"
                  >
                    <span className={`stage-dot stage-dot--${item[2]}`} aria-hidden="true" />
                    <span>{String(index + 1).padStart(2, "0")} · {item[1]}</span>
                  </button>
                ))}
              </div>
              <div
                aria-labelledby={`stage-tab-${activeStage}`}
                className="stage-panel"
                id="stage-panel"
                role="tabpanel"
                tabIndex="0"
              >
                <div className="stage-panel__eyebrow">
                  <span>{c.sampleLabel}</span>
                  <span className={`status status--${stage[2]}`}>{c.statuses[stage[2]]}</span>
                </div>
                <p className="stage-panel__id">{stage[0]}</p>
                <h3>{stage[1]}</h3>
                <p className="stage-panel__description">{stage[4]}</p>
                <dl className="stage-meta">
                  <div>
                    <dt>{c.humanGate}</dt>
                    <dd>{stage[3] ? c.required : c.notRequired}</dd>
                  </div>
                  <div>
                    <dt>{c.boundariesLabel}</dt>
                    <dd>
                      <ul>{c.boundaries.map((item) => <li key={item}>{item}</li>)}</ul>
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </section>

        <section className="trust section-shell section-block" id="trust" aria-labelledby="trust-title">
          <SectionIntro kicker={c.trustKicker} title={c.trustTitle} titleId="trust-title" body={c.trustBody} />
          <div className="trust-list">
            {c.trustItems.map(([title, body], index) => (
              <article className="trust-row" key={title}>
                <span className="trust-row__number">0{index + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="languages section-block" id="languages" aria-labelledby="languages-title">
          <div className="section-shell">
            <SectionIntro kicker={c.languagesKicker} title={c.languagesTitle} titleId="languages-title" body={c.languagesBody} />
            <div className="language-grid">
              {c.languageItems.map(([name, code, state, detail]) => (
                <article className="language-lane" key={code}>
                  <div className="language-lane__heading"><h3>{name}</h3><span>{code}</span></div>
                  <p className="language-lane__state"><span aria-hidden="true">✓</span>{state}</p>
                  <p>{detail}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="research section-shell section-block" id="research" aria-labelledby="research-title">
          <SectionIntro kicker={c.researchKicker} title={c.researchTitle} titleId="research-title" body={c.researchBody} />
          <div className="stats-grid">
            {c.stats.map(([value, label]) => (
              <div className="stat" key={value}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <p className="research-note"><span aria-hidden="true">i</span>{c.researchNote}</p>
        </section>

        <section className="closing section-shell" aria-labelledby="closing-title">
          <div>
            <p className="kicker">Suara · Phase 0</p>
            <h2 id="closing-title">{c.closeTitle}</h2>
            <p>{c.closeBody}</p>
          </div>
          <a className="button button--light" href={prototypeHref}>{c.closeButton} <ArrowIcon /></a>
        </section>
      </main>

      <footer className="site-footer">
        <div className="section-shell footer-grid">
          <div>
            <a className="wordmark wordmark--footer" href="#top"><span className="wordmark__pulse" aria-hidden="true" />Suara</a>
            <p>{c.footerTag}</p>
          </div>
          <p className="footer-status">{c.footerStatus}</p>
          <a className="footer-top" href="#top">{c.backTop} ↑</a>
        </div>
      </footer>
    </>
  );
}

export default App;
