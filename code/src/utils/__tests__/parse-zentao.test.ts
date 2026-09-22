import { describe, it, expect, spyOn } from "bun:test";
import { parseZentaoText } from "../parse-zentao";

/** 形态 1：自定义「标签文本」模板（老格式，信息最全） */
const LABEL_TEXT = `【🔔 禅道BUG修改提醒】
🧑‍💻 创建人：张三
🎬 操作人：李四
👤 指派人：王五
📝 BUG标题：页面白屏
🆔 BUG编号：#80407
📊 BUG状态：active
⚡ 优先级：3
💥 严重程度：3
🧾 BUG描述：打开首页后白屏
📋 重现步骤：1. 登录
2. 进入首页
✅ 期望结果：页面正常展示
❌ 实际结果：页面白屏
🔗 详情链接：http://zentao.example.com/bug-view-80407.html`;

/** 形态 2：标准禅道原生 payload —— 2026-09-22 从用户本地禅道实抓 */
const NATIVE_OPENED = {
  objectType: "bug",
  objectID: 5,
  product: ",1,",
  action: "opened",
  actor: "admin",
  date: "2026-09-22 23:09:16",
  comment: "",
  text: "admin创建了Bug [#5::[白屏]agent连通性测试](http://100.98.41.37/zentao/bug-view-5.html)",
};

describe("parseZentaoText — 标签文本格式", () => {
  it("解析出全部字段", () => {
    const parsed = parseZentaoText({ text: LABEL_TEXT });
    expect(parsed).not.toBeNull();
    expect(parsed!.bugId).toBe("80407");
    expect(parsed!.title).toBe("页面白屏");
    expect(parsed!.status).toBe("active");
    expect(parsed!.priority).toBe("3");
    expect(parsed!.severity).toBe("3");
    expect(parsed!.creator).toBe("张三");
    expect(parsed!.operator).toBe("李四");
    expect(parsed!.assignee).toBe("王五");
    expect(parsed!.description).toBe("打开首页后白屏");
    expect(parsed!.steps).toContain("2. 进入首页");
    expect(parsed!.expected).toBe("页面正常展示");
    expect(parsed!.actual).toBe("页面白屏");
    expect(parsed!.link).toBe("http://zentao.example.com/bug-view-80407.html");
  });

  it("缺 BUG编号 时返回 null（无法定位 issue）", () => {
    expect(parseZentaoText({ text: "📝 BUG标题：页面白屏\n📊 BUG状态：active" })).toBeNull();
  });

  it("空 payload 返回 null", () => {
    expect(parseZentaoText({})).toBeNull();
    expect(parseZentaoText({ text: "" })).toBeNull();
  });
});

describe("parseZentaoText — 禅道原生格式", () => {
  it("读取禅道端扩展注入的 Bug 实体字段", () => {
    const parsed = parseZentaoText({
      objectType: "bug",
      objectID: 12,
      action: "opened",
      actor: "admin",
      title: "列表页白屏",
      steps: "<p>打开列表页后页面白屏</p>",
      status: "active",
      pri: 2,
      severity: 1,
      openedBy: "tester",
      assignedTo: "dev",
      text: "admin创建了Bug [#12::列表页白屏](http://zentao.example.com/bug-view-12.html)",
    });

    expect(parsed).toMatchObject({
      bugId: "12",
      title: "列表页白屏",
      steps: "<p>打开列表页后页面白屏</p>",
      status: "active",
      priority: "2",
      severity: "1",
      creator: "tester",
      assignee: "dev",
    });
  });

  it("扩展 status 不覆盖旧版 action 状态语义", () => {
    const parsed = parseZentaoText({
      objectType: "bug",
      objectID: 13,
      action: "resolved",
      status: "active",
      text: "admin解决了Bug [#13::已解决问题](http://zentao.example.com/bug-view-13.html)",
    });

    expect(parsed?.status).toBe("resolved");
  });

  it("opened → status 归一为 active（会入队）", () => {
    const parsed = parseZentaoText(NATIVE_OPENED);
    expect(parsed).not.toBeNull();
    expect(parsed!.bugId).toBe("5");
    expect(parsed!.title).toBe("[白屏]agent连通性测试");
    expect(parsed!.status).toBe("active");
    expect(parsed!.link).toBe("http://100.98.41.37/zentao/bug-view-5.html");
    expect(parsed!.operator).toBe("admin");
    expect(parsed!.creator).toBe("admin");
  });

  it("标题里的方括号不会把正则带偏", () => {
    const parsed = parseZentaoText({
      objectID: 9,
      action: "opened",
      text: "x创建了Bug [#9::[白屏][列表]页面无数据](http://z.example.com/bug-view-9.html)",
    });
    expect(parsed!.title).toBe("[白屏][列表]页面无数据");
    expect(parsed!.bugId).toBe("9");
  });

  it("resolved / closed / deleted → 原状态（不入队）", () => {
    for (const action of ["resolved", "closed", "deleted"]) {
      const parsed = parseZentaoText({ objectID: 6, action, text: NATIVE_OPENED.text });
      expect(parsed!.status).toBe(action);
    }
  });

  it("edited / assigned / activated → active", () => {
    for (const action of ["edited", "assigned", "activated"]) {
      const parsed = parseZentaoText({ objectID: 6, action, text: "" });
      expect(parsed!.status).toBe("active");
    }
  });

  it("未知 action 原样保留且只告警（不会误入队）", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseZentaoText({ objectID: 7, action: "reopened_by_some_new_zentao", text: "" });
    expect(parsed!.status).toBe("reopened_by_some_new_zentao");
    expect(parsed!.status).not.toBe("active");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("commented 事件：禅道的「备注」会作为描述（唯一能带自由文本的字段）", () => {
    const parsed = parseZentaoText({
      objectType: "bug",
      objectID: 9,
      action: "commented",
      actor: "admin",
      comment: "复现步骤：1. 打开列表页；2. 下拉刷新 → 列表不渲染，接口返回 200",
      text: "admin备注了Bug [#9::[白屏]列表页不渲染](http://z.example.com/bug-view-9.html)",
    });
    expect(parsed!.status).toBe("active");
    expect(parsed!.description).toContain("复现步骤");
    expect(parsed!.title).toBe("[白屏]列表页不渲染");
  });

  it("bugconfirmed 也算进行中，不会落到「未知 action」", () => {
    const parsed = parseZentaoText({ objectID: 10, action: "bugconfirmed", text: "" });
    expect(parsed!.status).toBe("active");
  });

  it("不带 scheme 的链接会补上 http://", () => {
    const parsed = parseZentaoText({
      objectID: 6,
      action: "opened",
      text: "admin创建了Bug [#6::[白屏]x](100.98.41.37/zentao/bug-view-6.html)",
    });
    expect(parsed!.link).toBe("http://100.98.41.37/zentao/bug-view-6.html");
  });

  it("没有 markdown 链接时，标题回退为纯文本", () => {
    const noLink = parseZentaoText({ objectID: 10, action: "opened", text: "admin修改了Bug 的标题" });
    expect(noLink!.bugId).toBe("10");
    expect(noLink!.title).toBe("admin修改了Bug 的标题");

    // 有链接时走链接分支，标题只取中括号内那段
    const withLink = parseZentaoText({ objectID: 8, action: "opened", text: "admin创建了Bug [#8::x](y)" });
    expect(withLink!.bugId).toBe("8");
    expect(withLink!.title).toBe("x");
  });

  it("有 objectID 但没 text 也能解析", () => {
    const parsed = parseZentaoText({ objectType: "bug", objectID: 11, action: "opened" });
    expect(parsed!.bugId).toBe("11");
    expect(parsed!.status).toBe("active");
    expect(parsed!.title).toBe("");
  });

  it("原生 action 优先于模板里写死的状态文本", () => {
    const parsed = parseZentaoText({
      objectID: 12,
      action: "resolved",
      text: "📝 BUG标题：页面白屏\n🆔 BUG编号：#12\n📊 BUG状态：active",
    });
    expect(parsed!.bugId).toBe("12");
    expect(parsed!.status).toBe("resolved");
  });
});

describe("parseZentaoText — 原生 + 标签混合", () => {
  it("模板里带了描述/步骤时，标签字段优先被采用", () => {
    const parsed = parseZentaoText({
      objectID: 5,
      action: "opened",
      actor: "admin",
      text: `【🔔 禅道BUG修改提醒】
📝 BUG标题：[白屏]页面白屏
🆔 BUG编号：#5
📊 BUG状态：active
🧾 BUG描述：进入列表页白屏，接口返回正常
🔗 详情链接：http://100.98.41.37/zentao/bug-view-5.html`,
    });
    expect(parsed!.bugId).toBe("5");
    expect(parsed!.title).toBe("[白屏]页面白屏");
    expect(parsed!.description).toBe("进入列表页白屏，接口返回正常");
    expect(parsed!.status).toBe("active");
  });
});
