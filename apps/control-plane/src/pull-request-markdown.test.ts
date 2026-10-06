import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { htmlText, remarkHtmlAsText } from "./pull-request-markdown";

function render(text: string) {
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkHtmlAsText] }, text));
}

describe("remarkHtmlAsText", () => {
  it("keeps the text inside an HTML block", () => {
    expect(render('<p align="center">Hello <b>world</b> &amp; friends</p>')).toBe("<p>Hello world &amp; friends</p>");
  });

  it("drops comments and markup with no text", () => {
    expect(render("<!-- cubic:summary -->\n\nVisible\n\n<a href=\"https://cubic.dev\"><picture><img alt=\"Review\"></picture></a>")).toBe("<p>Visible</p>");
  });

  it("keeps inline text and the markdown inside details", () => {
    expect(render("Written for <sup>commit</sup> abc.")).toBe("<p>Written for commit abc.</p>");
    expect(render("<details>\n<summary>Prompt</summary>\n\n- Fix it\n\n</details>")).toBe("<p>Prompt</p>\n<ul>\n<li>Fix it</li>\n</ul>");
  });

  it("never renders the HTML as markup", () => {
    expect(render("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>")).toBe("<p>alert(1)</p>");
  });

  it("removes tags rebuilt from nested fragments", () => {
    expect(htmlText("<scr<script>ipt>alert(1)</script>")).not.toMatch(/[<>]/u);
    expect(htmlText("<!<!--- comment --->-->text")).toBe("text");
  });

  it("keeps an entity that names no character", () => {
    expect(htmlText("<b>&#99999999; &#x41; &bogus;</b>")).toBe("&#99999999; A &bogus;");
  });

  it("keeps adjacent blocks and line breaks apart", () => {
    expect(htmlText("<p>first</p><p>second</p>")).toMatch(/^first\s+second\s*$/u);
    expect(htmlText("one<br>two<br/>three")).toBe("one\ntwo\nthree");
  });

  it("decodes the entities GitHub text commonly uses", () => {
    expect(htmlText("<p>Wait&hellip; it&rsquo;s &ldquo;done&rdquo; &mdash; &copy; &middot;</p>")).toBe("Wait… it’s “done” — © ·\n");
  });
});
