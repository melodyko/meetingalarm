import type { Metadata, Viewport } from "next";
import "./globals.css";

// iPad mini 3 is capped at iOS 12.5.8. Vite can downlevel JavaScript syntax,
// but it does not polyfill newer built-ins used by Vinext's browser runtime.
// Keep this script ES5-compatible and run it before the client module scripts.
const legacySafariPolyfills = `
(function () {
  if (typeof window.globalThis === "undefined") {
    window.globalThis = window;
  }

  if (!Object.hasOwn) {
    Object.hasOwn = function (object, property) {
      return Object.prototype.hasOwnProperty.call(Object(object), property);
    };
  }

  if (!String.prototype.replaceAll) {
    Object.defineProperty(String.prototype, "replaceAll", {
      configurable: true,
      writable: true,
      value: function (search, replacement) {
        var value = String(this);
        if (search instanceof RegExp) {
          if (!search.global) {
            throw new TypeError("replaceAll requires a global RegExp");
          }
          return value.replace(search, replacement);
        }
        var needle = String(search);
        if (needle === "") {
          return value.replace(/(?:)/g, replacement);
        }
        return value.split(needle).join(replacement);
      }
    });
  }

  if (!String.prototype.matchAll) {
    Object.defineProperty(String.prototype, "matchAll", {
      configurable: true,
      writable: true,
      value: function (pattern) {
        var expression = pattern instanceof RegExp ? pattern : new RegExp(pattern, "g");
        if (!expression.global) {
          throw new TypeError("matchAll requires a global RegExp");
        }
        var flags = "g";
        if (expression.ignoreCase) flags += "i";
        if (expression.multiline) flags += "m";
        if (expression.unicode) flags += "u";
        if (expression.sticky) flags += "y";
        var matcher = new RegExp(expression.source, flags);
        matcher.lastIndex = expression.lastIndex;
        var input = String(this);
        var iterator = {
          next: function () {
            var match = matcher.exec(input);
            if (match === null) return { value: undefined, done: true };
            if (match[0] === "") matcher.lastIndex += 1;
            return { value: match, done: false };
          }
        };
        iterator[Symbol.iterator] = function () { return this; };
        return iterator;
      }
    });
  }
})();
`;

export const metadata: Metadata = {
  title: "会议铃｜好车主产品组会议看板",
  description: "清晰、实时的团队会议安排与提醒看板。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f3ed",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <script dangerouslySetInnerHTML={{ __html: legacySafariPolyfills }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
