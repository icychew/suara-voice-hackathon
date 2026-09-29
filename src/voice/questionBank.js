// Question text/metadata ported verbatim from icychew/suara-voice-archive,
// agent/questions.py at 71b2d43c016c0af22cfa56adecf031fc45b9abf3.
// Copyright (c) 2026 Suara Voice Archive.
// Full MIT notice: licenses/suara-question-bank-MIT.txt.
// This bank-guided plan is separate from the unchanged three-question demo.
// EN/ZH text availability is not proof of any spoken-language capability.

export const MAX_INTERVIEW_QUESTIONS = 8;
export const QUESTION_POLICY = "bank-v1";
export const OPENING_QUESTION_ID = "birthplace";

export const QUESTION_BANK = Object.freeze([
  { id: "birthplace", era: "childhood", order: 10,
    text_en: "Where were you born, and what did that place look like?",
    text_zh: "您在哪里出生？那个地方是什么样子的？" },
  { id: "childhood_home", era: "childhood", order: 20,
    text_en: "Tell me about the house you grew up in. What do you remember when you walk through the front door in your mind?",
    text_zh: "说说您长大的那间屋子。在心里走进大门的时候，您记得什么？" },
  { id: "parents", era: "childhood", order: 30,
    text_en: "What were your parents like? Not what they did -- what they were like.",
    text_zh: "您的父母是怎样的人？不是他们做什么工作，是他们这个人。" },
  { id: "siblings", era: "childhood", order: 40,
    text_en: "Who else was in the house? Brothers, sisters, anyone who stayed with you?",
    text_zh: "家里还有谁？兄弟姐妹，或者跟你们一起住的人？" },
  { id: "childhood_food", era: "childhood", order: 50,
    text_en: "What did your mother cook that you still think about?",
    text_zh: "您母亲煮的什么菜，您到现在还会想起？" },
  { id: "school", era: "childhood", order: 60,
    text_en: "What was school like? Did you want to go?",
    text_zh: "上学是什么样的？您喜欢去吗？" },
  { id: "language_home", era: "childhood", order: 70,
    text_en: "What language did you speak at home when you were small?",
    text_zh: "小时候在家里说什么话？" },
  { id: "first_work", era: "youth", order: 80,
    text_en: "What was the first work you ever did for money?",
    text_zh: "您第一份赚钱的工作是什么？" },
  { id: "leaving_home", era: "youth", order: 90,
    text_en: "Do you remember the first time you left home for somewhere far?",
    text_zh: "您还记得第一次离家去很远的地方吗？" },
  { id: "hard_years", era: "youth", order: 100,
    text_en: "Was there a stretch of years that was harder than the others?",
    text_zh: "有没有哪几年特别难过？" },
  { id: "meeting_partner", era: "adulthood", order: 110,
    text_en: "How did you meet your husband / your wife?",
    text_zh: "您和您先生／太太是怎么认识的？" },
  { id: "wedding", era: "adulthood", order: 120,
    text_en: "What do you remember about the wedding day itself?",
    text_zh: "结婚那天，您记得什么？" },
  { id: "first_child", era: "adulthood", order: 130,
    text_en: "Tell me about becoming a parent for the first time.",
    text_zh: "第一次做父母，是什么感觉？" },
  { id: "raising_family", era: "adulthood", order: 140,
    text_en: "What was a normal week like when the children were small?",
    text_zh: "孩子小的时候，平常一个星期是怎么过的？" },
  { id: "work_life", era: "adulthood", order: 150,
    text_en: "What work did you do for most of your life? Did you like it?",
    text_zh: "您大半辈子做的是什么工作？喜欢吗？" },
  { id: "money_tight", era: "adulthood", order: 160,
    text_en: "Was there a time when money was very tight? How did you manage?",
    text_zh: "有没有一段时间钱很紧？您怎么应付过来的？" },
  { id: "home_moves", era: "adulthood", order: 170,
    text_en: "How many places have you lived? Which one felt most like home?",
    text_zh: "您住过几个地方？哪一个最像家？" },
  { id: "friend", era: "adulthood", order: 180,
    text_en: "Who was your closest friend, and what happened to them?",
    text_zh: "您最好的朋友是谁？后来怎么样了？" },
  { id: "loss", era: "adulthood", order: 190,
    text_en: "Is there someone you lost that you'd want your grandchildren to know about?",
    text_zh: "有没有哪位过世的人，您希望孙子孙女知道他？" },
  { id: "proud", era: "reflection", order: 200,
    text_en: "What is something you did that you're proud of, even if nobody else noticed?",
    text_zh: "有什么事情您做了很自豪，就算没有人注意到？" },
  { id: "regret", era: "reflection", order: 210,
    text_en: "Is there anything you'd do differently?",
    text_zh: "有没有什么事，您会想换个做法？" },
  { id: "changed", era: "reflection", order: 220,
    text_en: "What has changed the most in Malaysia since you were young?",
    text_zh: "从您年轻到现在，马来西亚变化最大的是什么？" },
  { id: "tradition", era: "reflection", order: 230,
    text_en: "Is there something your family always did that you hope continues?",
    text_zh: "有没有什么家里一直做的事，您希望能传下去？" },
  { id: "advice", era: "reflection", order: 240,
    text_en: "What would you want your great-grandchildren to know?",
    text_zh: "您希望曾孙知道什么？" },
  { id: "anything_else", era: "reflection", order: 250,
    text_en: "Is there anything I haven't asked about that you want on the record?",
    text_zh: "有没有什么我没问到，但您想记下来的？" },
].map((question) => Object.freeze(question)));

// Null prototype prevents inherited property names from becoming question IDs.
export const QUESTION_BY_ID = Object.freeze(Object.assign(
  Object.create(null), Object.fromEntries(QUESTION_BANK.map((question) => [question.id, question])),
));

const EMPTY_QUESTIONS = Object.freeze([]);

export function eligibleQuestions(askedIds) {
  if (!Array.isArray(askedIds)) throw new TypeError("asked IDs must be an array");
  if (askedIds.length > MAX_INTERVIEW_QUESTIONS) throw new RangeError("question limit exceeded");
  const seen = new Set();
  let lastOrder = 0;
  for (let index = 0; index < askedIds.length; index += 1) {
    if (!Object.hasOwn(askedIds, index)) throw new TypeError("asked IDs must be a dense array");
    const id = askedIds[index];
    if (typeof id !== "string" || !Object.hasOwn(QUESTION_BY_ID, id)) {
      throw new TypeError("unknown question ID");
    }
    const question = QUESTION_BY_ID[id];
    if (seen.has(id)) throw new TypeError("asked IDs must be unique");
    if (question.order <= lastOrder) throw new TypeError("asked IDs must be chronological");
    seen.add(id);
    lastOrder = question.order;
  }
  if (askedIds.length === MAX_INTERVIEW_QUESTIONS) return EMPTY_QUESTIONS;
  return Object.freeze(QUESTION_BANK.filter((question) => question.order > lastOrder));
}

export function fallbackQuestion(askedIds) {
  return eligibleQuestions(askedIds)[0] ?? null;
}
