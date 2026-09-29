// Separate consent/disclosure for Streaming STT + local speech synthesis.
// Do not reuse the managed Voice Agent recording/timeline assertions here.
export const STREAMING_COPY = {
  en: {
    mode: { name: "Suara adaptive prototype", badge: "Experimental", detail: "Streaming STT + local patience rules. Three fixed questions, device-local English voice. No proven advantage yet." },
    notice: "Requires host activation and an installed English voice. The default plan has three fixed questions. Optional AI bank selection below is a separate experimental plan, not a valid three-arm benchmark.",
    ready: "Streaming model/mode checked. Timing application remains unconfirmed.",
    controlLabel: "Experimental control requests",
    control: "Latest requested wait: {min}–{max} ms · {count} updates queued. Not proof of provider application or improved patience.",
    overrides: {
      consentDetail: "If you consent, microphone audio streams directly to AssemblyAI Streaming STT. Its provider-side data handling applies; Suara does not store audio or transcripts. Only fixed interview questions go to a browser-reported device-local English voice. The copy shown on this page clears when you reset or leave; this does not delete provider-side data.",
      privacyItems: [
        ["Processed by AssemblyAI", "Microphone audio goes directly to Streaming STT. Provider-side data controls and retention apply; this is not the managed Voice Agent recording/timeline product."],
        ["Local questions and preview", "Three fixed questions are spoken using a browser-reported local English voice. Transcripts and preview stay in tab memory. The access service keeps request times and short-lived security identifiers, not audio or transcripts."],
        ["Your review remains essential", "Reset or close the tab to clear its copy, not the provider's data. This prototype does not generate memoir prose or prove reduced interruptions."],
      ],
    },
    speechError: "An installed, device-local English voice was unavailable or could not finish. No remote voice was selected. Try another browser/device or choose the managed mode.",
  },
  ms: {
    mode: { name: "Prototaip adaptif Suara", badge: "Eksperimen", detail: "Streaming STT + peraturan jeda tempatan. Tiga soalan tetap, suara Inggeris pada peranti. Kelebihan belum terbukti." },
    notice: "Memerlukan pengaktifan hos dan suara Inggeris yang dipasang. Pelan lalai mempunyai tiga soalan tetap. Pemilihan AI pilihan di bawah ialah pelan eksperimen berasingan, bukan penanda aras tiga mod yang sah.",
    ready: "Model/mod Streaming diperiksa. Pelaksanaan tetapan masa belum disahkan.",
    controlLabel: "Permintaan kawalan eksperimen",
    control: "Jeda terakhir diminta: {min}–{max} ms · {count} kemas kini dibariskan. Bukan bukti pelaksanaan penyedia atau penambahbaikan.",
    overrides: {
      consentDetail: "Dengan persetujuan anda, audio mikrofon dihantar terus ke AssemblyAI Streaming STT. Pengendalian data pihak penyedia terpakai; Suara tidak menyimpan audio atau transkrip. Hanya soalan temu bual tetap dihantar kepada suara Inggeris yang dilaporkan oleh pelayar sebagai tempatan pada peranti. Salinan halaman dipadam apabila anda menetap semula atau keluar; data penyedia tidak dipadam.",
      privacyItems: [
        ["Diproses oleh AssemblyAI", "Audio mikrofon dihantar terus ke Streaming STT. Kawalan dan pengekalan data penyedia terpakai; ini bukan produk rakaman/garis masa Voice Agent terurus."],
        ["Soalan dan pratonton tempatan", "Tiga soalan tetap dibaca dengan suara Inggeris tempatan yang dilaporkan pelayar. Transkrip dan pratonton kekal dalam memori tab. Perkhidmatan akses menyimpan masa permintaan dan pengecam keselamatan sementara, bukan audio atau transkrip."],
        ["Semakan anda masih penting", "Tetap semula atau tutup tab untuk memadam salinannya, bukan data penyedia. Prototaip ini tidak menjana memoir atau membuktikan pengurangan gangguan."],
      ],
    },
    speechError: "Suara Inggeris tempatan pada peranti tidak tersedia atau tidak dapat selesai. Tiada suara awan dipilih. Cuba pelayar/peranti lain atau mod terurus.",
  },
  zh: {
    mode: { name: "Suara 自适应原型", badge: "实验功能", detail: "流式转录与本地停顿规则。三个固定问题，设备本地英语语音；尚未证明效果更好。" },
    notice: "需要主持人启用，并安装本地英语语音。默认使用三个固定问题。下方可选的 AI 题库选题是另一项实验方案，不是有效的三组对比。",
    ready: "已检查流式模型与模式；停顿设置是否生效仍未确认。",
    controlLabel: "实验性控制请求",
    control: "最近请求的等待时间：{min}–{max} 毫秒 · 已排队 {count} 次更新。不代表服务端已应用或耐心程度已改善。",
    overrides: {
      consentDetail: "经你同意，麦克风音频直接发送到 AssemblyAI 流式转录服务，并适用其数据处理规则。Suara 不保存音频或转录。只有固定采访问题会交给浏览器报告为设备本地的英语语音朗读。重置或离开页面会清除本页副本，不会删除服务商的数据。",
      privacyItems: [
        ["由 AssemblyAI 处理", "麦克风音频直接传给流式转录服务，适用服务商的数据控制与保留规则；这不是托管 Voice Agent 的录音与时间线产品。"],
        ["本地问题与预览", "三个固定问题由浏览器报告为本地的英语语音朗读。转录与预览只保留在标签页内存中。访问服务保存请求时间和短期安全标识，不保存音频或转录。"],
        ["仍需你审核", "重置或关闭标签页只清除本页副本，不删除服务商的数据。此原型不生成回忆录正文，也未证明能减少打断。"],
      ],
    },
    speechError: "设备本地英语语音不可用或未能完成朗读。系统没有改用云端语音。请尝试其他浏览器或设备，或选择托管模式。",
  },
};

export const CAPABILITY_COPY = {
  en: {
    check: "Check optional modes", checking: "Checking optional modes…",
    idle: "Enter your pilot code and check availability to unlock optional Streaming modes. This check leaves your microphone off.",
    disabled: "The host has not enabled Streaming or AI-selected questions. Adaptive pace and Patient pace remain available above.",
    streaming: "Streaming is enabled. AI-selected questions are unavailable on this host; the fixed three-question plan is available.",
    all: "Streaming and AI-selected questions are enabled by this host. Availability is checked again before the microphone opens.",
    locked: "Check availability below to unlock this option.",
    unavailable: "Unavailable on this host.",
    errors: {
      capabilities: "Optional-mode availability could not be checked. Retry the check or choose Adaptive pace or Patient pace.",
      streamingUnavailable: "The host has disabled Streaming. No microphone or provider session was opened. Start fresh and choose Adaptive pace or Patient pace.",
      questionsUnavailable: "The host has disabled AI-selected questions. No microphone or provider session was opened. Start fresh and use the fixed Streaming plan or a managed pace.",
      access: "The pilot code was not accepted. Correct it and check again.",
      capacity: "Too many access checks. Please wait before checking again.",
    },
  },
  ms: {
    check: "Semak mod pilihan", checking: "Menyemak mod pilihan…",
    idle: "Masukkan kod perintis dan semak ketersediaan untuk membuka mod Streaming pilihan. Semakan ini tidak menghidupkan mikrofon.",
    disabled: "Hos belum mengaktifkan Streaming atau soalan pilihan AI. Tempo adaptif dan tempo sabar masih tersedia di atas.",
    streaming: "Streaming diaktifkan. Soalan pilihan AI tidak tersedia pada hos ini; pelan tiga soalan tetap tersedia.",
    all: "Streaming dan soalan pilihan AI diaktifkan oleh hos ini. Ketersediaan disemak semula sebelum mikrofon dibuka.",
    locked: "Semak ketersediaan di bawah untuk membuka pilihan ini.",
    unavailable: "Tidak tersedia pada hos ini.",
    errors: {
      capabilities: "Ketersediaan mod pilihan tidak dapat disemak. Cuba semula atau pilih tempo adaptif atau tempo sabar.",
      streamingUnavailable: "Hos telah menyahaktifkan Streaming. Mikrofon dan sesi penyedia belum dibuka. Mulakan baharu dan pilih tempo adaptif atau tempo sabar.",
      questionsUnavailable: "Hos telah menyahaktifkan soalan pilihan AI. Mikrofon dan sesi penyedia belum dibuka. Mulakan baharu dengan pelan Streaming tetap atau tempo terurus.",
      access: "Kod perintis tidak diterima. Betulkan kod dan semak semula.",
      capacity: "Terlalu banyak semakan akses. Sila tunggu sebelum menyemak semula.",
    },
  },
  zh: {
    check: "检查可选模式", checking: "正在检查可选模式…",
    idle: "输入试用访问码并检查可用性，即可解锁可选的流式模式。检查期间麦克风保持关闭。",
    disabled: "主持人尚未启用流式模式或 AI 选题。仍可选择上方的自适应节奏和耐心节奏。",
    streaming: "流式模式已启用。此主机暂不提供 AI 选题，可使用三个固定问题的方案。",
    all: "此主机已启用流式模式和 AI 选题。打开麦克风前会再次检查可用性。",
    locked: "请在下方检查可用性以解锁此选项。",
    unavailable: "此主机暂不提供。",
    errors: {
      capabilities: "无法检查可选模式。请重试，或选择自适应节奏或耐心节奏。",
      streamingUnavailable: "主持人已关闭流式模式。麦克风和服务商会话均未打开。请重新开始，并选择自适应节奏或耐心节奏。",
      questionsUnavailable: "主持人已关闭 AI 选题。麦克风和服务商会话均未打开。请重新开始，使用固定问题流式方案或托管模式。",
      access: "试用访问码未获接受。请更正后重新检查。",
      capacity: "访问检查次数过多。请稍后再试。",
    },
  },
};

// This opt-in changes the data route. Keep all visible consent/privacy copy in
// sync; never leave the fixed plan's 'not sent to our server' claim selected.
export const PERSONALISED_COPY = {
  en: {
    label: "Use AI-selected questions · optional",
    detail: "Up to 8 questions from a 25-question bank, within 10 minutes. Sends short final-answer excerpts through Suara’s Vercel server to AssemblyAI LLM Gateway and its model provider. Requires separate host activation; not available through the local facade. A failed or interrupted request switches to local bank order for the rest of the session.",
    selection: { pending: "Choosing from the question bank…", ai: "Latest question: AI-selected from the bank.", bank: "Opening question: fixed bank entry.", fallback: "AI selection unavailable or interrupted. Using local bank order for the rest of this session." },
    overrides: {
      intro: "Explore your life story with up to eight bank questions. Your own words form a local, evidence-linked preview for you to review.",
      setupBody: "Find a quiet spot and use headphones if possible. This optional plan changes question selection and transcript processing; it is not a like-for-like comparison with the three-question modes.",
      start: "Start bank-guided interview",
      consent: "I consent to microphone audio going to AssemblyAI Streaming STT, and short answer excerpts going through Suara’s server to AssemblyAI LLM Gateway and its model provider for question selection.",
      consentDetail: "Only the latest two final answers, limited to 4,000 characters in total, are sent for each selection. Suara’s application does not persist or log their text; hosting and provider data handling still apply. Only allowlisted bank questions go to a browser-reported device-local English voice. Avoid sensitive information. Reset clears this tab, not provider-side data.",
      clearWarning: "Starting fresh clears this page’s conversation and preview. It does not delete data handled by the providers.",
      questionsTitle: "A guided route, with room to stop",
      questions: [["Begin with a place", "Start with where you were born."], ["Follow your memories", "AI selects later questions from the bank, or local order takes over if unavailable. No free-form generated questions."], ["You choose when to finish", "Up to eight questions or ten minutes. Stop at any time and review only your own words."]],
      privacyItems: [
        ["Audio to AssemblyAI", "Microphone audio streams directly to Streaming STT. Its data controls and retention apply."],
        ["Excerpts for question selection", "Up to two final answers (4,000 characters total) pass through Suara on Vercel to AssemblyAI LLM Gateway and its model provider. Our application does not store or log the text. Short-lived access records contain identifiers and selected question IDs, not transcripts."],
        ["Preview stays in this tab", "The preview uses your words only and needs your review. Reset clears its local copy, not hosting or provider-side data. Spoken replies remain English; the BM interface is not Malay speech support."],
      ],
    },
  },
  ms: {
    label: "Gunakan soalan pilihan AI · pilihan tambahan",
    detail: "Sehingga 8 soalan daripada bank 25 soalan, dalam 10 minit. Petikan jawapan akhir dihantar melalui pelayan Vercel Suara ke AssemblyAI LLM Gateway dan penyedia modelnya. Memerlukan pengaktifan hos berasingan; tidak tersedia melalui fasad tempatan. Permintaan gagal atau terganggu menukar baki sesi kepada susunan bank tempatan.",
    selection: { pending: "Memilih daripada bank soalan…", ai: "Soalan terkini: dipilih AI daripada bank.", bank: "Soalan pembukaan: entri bank tetap.", fallback: "Pemilihan AI tidak tersedia atau terganggu. Baki sesi menggunakan susunan bank tempatan." },
    overrides: {
      intro: "Terokai kisah hidup dengan sehingga lapan soalan daripada bank. Kata-kata anda membentuk pratonton tempatan berpaut bukti untuk disemak.",
      setupBody: "Cari tempat sunyi dan gunakan fon kepala jika boleh. Pelan pilihan ini mengubah pemilihan soalan serta pemprosesan transkrip; ia bukan perbandingan setara dengan mod tiga soalan.",
      start: "Mulakan temu bual berpandu bank",
      consent: "Saya bersetuju audio mikrofon dihantar ke AssemblyAI Streaming STT, dan petikan jawapan melalui pelayan Suara ke AssemblyAI LLM Gateway serta penyedia modelnya untuk pemilihan soalan.",
      consentDetail: "Hanya dua jawapan akhir terkini, terhad kepada 4,000 aksara keseluruhan, dihantar bagi setiap pemilihan. Aplikasi Suara tidak menyimpan atau merekod teksnya dalam log; pengendalian data hos dan penyedia tetap terpakai. Hanya soalan bank yang dibenarkan dihantar kepada suara Inggeris yang dilaporkan pelayar sebagai tempatan pada peranti. Elakkan maklumat sensitif. Tetap semula memadam tab ini, bukan data penyedia.",
      clearWarning: "Mula semula memadam perbualan dan pratonton halaman ini. Ia tidak memadam data yang dikendalikan oleh penyedia.",
      questionsTitle: "Laluan berpandu, boleh dihentikan",
      questions: [["Mulakan dengan tempat", "Bermula dengan tempat anda dilahirkan."], ["Ikuti kenangan anda", "AI memilih soalan seterusnya daripada bank, atau susunan tempatan digunakan jika tidak tersedia. Tiada soalan bebas dijana."], ["Anda tentukan bila berhenti", "Sehingga lapan soalan atau sepuluh minit. Berhenti bila-bila masa dan semak kata-kata anda sahaja."]],
      privacyItems: [
        ["Audio ke AssemblyAI", "Audio mikrofon dihantar terus ke Streaming STT. Kawalan data dan pengekalan penyedia terpakai."],
        ["Petikan untuk memilih soalan", "Sehingga dua jawapan akhir (4,000 aksara keseluruhan) melalui Suara di Vercel ke AssemblyAI LLM Gateway dan penyedia modelnya. Aplikasi kami tidak menyimpan atau merekod teks dalam log. Rekod akses sementara mengandungi pengecam dan ID soalan pilihan, bukan transkrip."],
        ["Pratonton kekal dalam tab", "Pratonton hanya menggunakan kata-kata anda dan perlu disemak. Tetap semula memadam salinan tempatan, bukan data hos atau penyedia. Jawapan suara kekal dalam bahasa Inggeris; antara muka BM tidak bermakna sokongan suara Melayu."],
      ],
    },
  },
  zh: {
    label: "使用 AI 题库选题 · 可选",
    detail: "在十分钟内，从 25 道题中最多问八道。简短的最终回答片段会经 Suara 的 Vercel 服务发送至 AssemblyAI LLM Gateway 及其模型服务商。需要主持人另行启用；本地访问服务不支持此功能。请求失败或被打断后，本次余下采访改用本地题库顺序。",
    selection: { pending: "正在从题库选题…", ai: "最近问题：由 AI 从题库选择。", bank: "开场问题：固定题库条目。", fallback: "AI 选题不可用或已被打断；本次余下采访使用本地题库顺序。" },
    overrides: {
      intro: "用最多八道题库问题探索人生故事。你的原话会组成可追溯来源的本地预览，供你审核。",
      setupBody: "找一个安静的位置，尽量使用耳机。此可选方案会改变选题及转录处理方式，不能与三个固定问题的模式直接作同条件比较。",
      start: "开始题库引导采访",
      consent: "我同意将麦克风音频发送到 AssemblyAI 流式转录，并将简短回答片段经 Suara 服务发送到 AssemblyAI LLM Gateway 及其模型服务商，用于选题。",
      consentDetail: "每次选题仅发送最近两条最终回答，总计不超过 4,000 个字符。Suara 应用不持久保存或记录这些文本，但仍适用托管平台及服务商的数据处理规则。只有允许的题库问题会交给浏览器报告为设备本地的英语语音。请勿分享敏感信息。重置只清除本标签页，不删除服务商的数据。",
      clearWarning: "重新开始会清除本页对话和预览，不会删除服务商处理的数据。",
      questionsTitle: "有引导，也可随时停止",
      questions: [["从一个地方开始", "先聊聊你的出生地。"], ["顺着回忆前进", "AI 从题库选择之后的问题；不可用时改用本地顺序，不生成自由文本问题。"], ["由你决定何时结束", "最多八道问题或十分钟。可随时停止，只审核你自己的原话。"]],
      privacyItems: [
        ["音频交给 AssemblyAI", "麦克风音频直接发送到流式转录服务，适用其数据控制及保留规则。"],
        ["回答片段用于选题", "最多两条最终回答、总计 4,000 字符，经 Vercel 上的 Suara 发送至 AssemblyAI LLM Gateway 及其模型服务商。我们的应用不保存或记录文本。短期访问记录包含安全标识及所选问题 ID，不含转录。"],
        ["预览留在标签页", "预览只使用你的原话，仍需你审核。重置仅清除本地副本，不删除托管平台或服务商的数据。语音回复仍为英语；BM 界面不代表支持马来语语音。"],
      ],
    },
  },
};
