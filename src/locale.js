export const INTERFACE_LOCALES = Object.freeze(["ms", "en", "zh"]);

export function normalizeInterfaceLocale(candidate, fallback = "en") {
  const safeFallback = INTERFACE_LOCALES.includes(fallback) ? fallback : "en";
  return INTERFACE_LOCALES.includes(candidate) ? candidate : safeFallback;
}

export function readInterfaceLocale(search = "") {
  try {
    return normalizeInterfaceLocale(new URLSearchParams(search).get("lang"));
  } catch {
    return "en";
  }
}

export function withInterfaceLocale(path, locale) {
  const url = new URL(path, "https://suaraproject.tech");
  url.searchParams.set("lang", normalizeInterfaceLocale(locale));
  return `${url.pathname}${url.search}${url.hash}`;
}
