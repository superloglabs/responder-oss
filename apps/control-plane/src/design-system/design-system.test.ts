import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable, type DataTableColumn } from "./design-system";

interface TestRow {
  date: string;
  id: string;
  title: string;
}

describe("DataTable", () => {
  it("renders adjacent row groups as separate labelled tables", () => {
    const columns: Array<DataTableColumn<TestRow>> = [
      {
        header: "Issue",
        key: "title",
        render: (row) => row.title,
      },
    ];
    const rows: Array<TestRow> = [
      { date: "Today", id: "issue-1", title: "First issue" },
      { date: "Today", id: "issue-2", title: "Second issue" },
      { date: "Yesterday", id: "issue-3", title: "Third issue" },
    ];
    const markup = renderToStaticMarkup(
      createElement(DataTable<TestRow>, {
        "aria-label": "Issues",
        columns,
        getRowGroup: (row) => row.date,
        getRowKey: (row) => row.id,
        rows,
      }),
    );

    expect(markup.match(/<table>/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Issues: Today"');
    expect(markup).toContain('aria-label="Issues: Yesterday"');
    expect(markup).toContain(">Today</h2>");
    expect(markup).toContain(">Yesterday</h2>");
    expect(markup).toContain("First issue");
    expect(markup).toContain("Third issue");
  });
});
