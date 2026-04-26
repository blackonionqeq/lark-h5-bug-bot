import { describe, it, expect } from "bun:test";
import { triage } from "../triage";

describe("triage", () => {
  describe("frontend signals", () => {
    it("classifies 页面 as frontend", () => {
      const result = triage("页面白屏报错", "");
      expect(result.label).toBe("frontend");
      expect(result.source).toBe("rules");
    });

    it("classifies 样式 as frontend", () => {
      const result = triage("样式错乱", "");
      expect(result.label).toBe("frontend");
    });

    it("classifies 浏览器兼容 as frontend", () => {
      const result = triage("浏览器兼容问题", "");
      expect(result.label).toBe("frontend");
    });

    it("classifies 布局 as frontend", () => {
      const result = triage("布局异常", "");
      expect(result.label).toBe("frontend");
    });

    it("classifies 白屏 as frontend", () => {
      const result = triage("用户反馈白屏", "");
      expect(result.label).toBe("frontend");
    });

    it("classifies 按钮点击无反应 as frontend", () => {
      const result = triage("提交按钮点击无反应", "点击按钮后无弹窗");
      expect(result.label).toBe("frontend");
    });

    it("classifies 控制台报错 as frontend", () => {
      const result = triage("", "控制台报错");
      expect(result.label).toBe("frontend");
      expect(result.matchedRules!.length).toBeGreaterThan(0);
    });
  });

  describe("backend signals", () => {
    it("classifies 接口报500 as non-frontend when no frontend signals present", () => {
      const result = triage("接口报500", "调用API返回500");
      expect(result.label).toBe("non-frontend");
    });

    it("classifies 数据库 as non-frontend", () => {
      const result = triage("数据库连接超时", "");
      expect(result.label).toBe("non-frontend");
    });

    it("classifies SQL as non-frontend", () => {
      const result = triage("SQL查询慢", "");
      expect(result.label).toBe("non-frontend");
    });

    it("classifies nginx as non-frontend", () => {
      const result = triage("nginx配置错误", "");
      expect(result.label).toBe("non-frontend");
    });

    it("classifies 部署 as non-frontend", () => {
      const result = triage("部署失败", "");
      expect(result.label).toBe("non-frontend");
    });

    it("classifies redis as non-frontend", () => {
      const result = triage("redis缓存问题", "");
      expect(result.label).toBe("non-frontend");
    });
  });

  describe("mixed signals", () => {
    it("classifies as frontend when frontend signals outweigh backend", () => {
      const result = triage("页面白屏报错，同时接口返回500", "");
      // frontend: 页面, 白屏 (+2); backend: 接口 (-1) => score 1 => frontend
      expect(result.label).toBe("frontend");
    });

    it("classifies as non-frontend when backend signals outweigh frontend", () => {
      const result = triage("页面加载慢，数据库连接超时，SQL查询慢，redis缓存失效", "");
      // frontend: 页面 (+1); backend: 数据库, SQL, redis (-3) => score -2 => non-frontend
      expect(result.label).toBe("non-frontend");
    });
  });

  describe("no signals match", () => {
    it("defaults to frontend when no rules match", () => {
      const result = triage("系统出现未知错误", "");
      expect(result.label).toBe("frontend");
      expect(result.reason).toContain("默认归类为前端");
    });

    it("defaults to frontend when both title and description are empty", () => {
      const result = triage("", "");
      expect(result.label).toBe("frontend");
    });

    it("defaults to frontend when no args are passed", () => {
      const result = triage();
      expect(result.label).toBe("frontend");
    });
  });

  describe("matchedRules tracking", () => {
    it("includes matched rules in result", () => {
      const result = triage("页面白屏", "");
      expect(result.matchedRules).toBeDefined();
      expect(result.matchedRules!.length).toBe(2);
      expect(result.matchedRules!.every(r => r.startsWith("frontend:"))).toBe(true);
    });
  });
});
