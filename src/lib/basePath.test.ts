import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "./basePath";

describe("normalizeBasePath（サブパス配置対応）", () => {
  it("未指定なら相対 base './'（ルートでもサブパスでも動く）", () => {
    expect(normalizeBasePath(undefined)).toBe("./");
    expect(normalizeBasePath(null)).toBe("./");
    expect(normalizeBasePath("")).toBe("./");
    expect(normalizeBasePath("   ")).toBe("./");
  });

  it("'./' はそのまま './'", () => {
    expect(normalizeBasePath("./")).toBe("./");
    expect(normalizeBasePath(".")).toBe("./");
  });

  it("絶対サブパスは末尾スラッシュを補う", () => {
    expect(normalizeBasePath("/chord-analyzer")).toBe("/chord-analyzer/");
    expect(normalizeBasePath("/chord-analyzer/")).toBe("/chord-analyzer/");
    expect(normalizeBasePath("/")).toBe("/");
  });

  it("前後の空白を取り除く", () => {
    expect(normalizeBasePath("  /repo/  ")).toBe("/repo/");
  });
});
