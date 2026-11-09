# dsh-recovery

给 DeepSeek Harness 用的「对话记忆恢复」插件：

- `/recovery create` —— 把当前对话打包成一条记忆，生成 **20 个字母的恢复码**；
- `/recovery memory <恢复码>` —— 在任意新对话里凭恢复码把这记忆注入回去，模型立刻接上之前的上下文。

记忆保存在本机 `$DSH_HOME/recovery/` 下，一个恢复码一个文件；不上传、不同步。

## 用法

| 输入 | 作用 |
|---|---|
| `/recovery create` | 打包当前对话，返回 20 字母恢复码 |
| `/recovery create <备注>` | 同上，并给这条记忆起个名字（列表里显示） |
| `/recovery memory <恢复码>` | 在新对话中恢复该记忆，并让模型自动总结上一段会话 |
| `/recovery memory<恢复码>` | 紧凑写法，等价于上一行 |
| `/recovery <恢复码>` | 只给恢复码时的简写 |
| `/recovery memory <恢复码> --no-summary` | 只恢复、这次不自动总结（`-n` 同义） |
| `/recovery list` | 列出本机保存的恢复码（最新在前，最多 10 条） |
| `/recovery delete <恢复码>` | 删除一条记忆 |
| `/recovery` / `/recovery help` | 显示用法 |

恢复码是 20 个大写字母，字母表去掉了 `I` 和 `O`（避免与 `1`/`0` 混淆），
显示时每 5 个字母一组：

```text
ABCDE-FGHJK-LMNPQ-RSTUV
```

输入时大小写、空格、`-`、`+`、`:` 都不敏感，下面三种写法指向同一条记忆：

```text
/recovery memory ABCDE-FGHJK-LMNPQ-RSTUV
/recovery memory abcde fghjk lmnpq rstuv
/recovery memoryABCDEFGHJKLMNPQRSTUV
```

### 典型流程

1. 在长对话里（比如做完一个项目、排查完一个 bug）执行 `/recovery create`，
   把返回的恢复码记下来（发给自己、贴进备忘录都行）。
2. 开一个新对话，第一件事执行 `/recovery memory ABCDE-FGHJK-LMNPQ-RSTUV`。
3. 恢复完成后，模型会**自动先总结一遍**那段会话（在做什么、结论、遗留事项），
   然后你再接着提问即可。

`/recovery memory` 做两件事：

1. 把记忆**注入上下文**（不直接触发回复的那种）；
2. 再发一条 `请总结上面恢复的这段会话。` 的唤醒消息，让模型先给出 3–6 条要点总结
   —— 这就是「自动总结上一段会话」。

也就是说注入的记忆和总结请求在同一轮里进入模型：先记忆、后请求。
总结是一次普通模型调用，会消耗 token；加 `--no-summary`（或 `-n`）只恢复不总结，
或在配置里把 `autoSummary` 设为 `false` 全局关闭。

## 安装

插件是纯 ESM、零运行时依赖（只用 Node 内置模块），可以直接以本地链接的方式装进
任意 DSH profile。

### 方式一：在 profile 里插入一行（推荐给自定义 profile）

```sh
# 1. 把包链接进 profile
cd "$DSH_HOME/profiles/web"
pnpm add link:/absolute/path/to/dsh-recovery
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾加上：

```yaml
- insert:
    - id: dsh-recovery
      name: dsh-recovery
      config:
        restoreChars: 12000
        maxRecordBytes: 400000
```

重启 `dsh web`（若 `hmr` 已启用，保存 patch 后自动热重载）。

### 方式二：作为 bundle 安装

把包放进 profile 依赖，并把包名加进 `package.json` 的
`dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-recovery"]
    }
  }
}
```

bundle 模式会应用本包自带的 `cordis.patch.yml`。

> ⚠️ 两种方式**只选一种**。同时生效会让 `/recovery` 注册两次，启动直接报错。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `restoreChars` | `12000` | 恢复时注入的摘要字符预算（约 4k tokens）。超出时保留开头 35% + 结尾 65% |
| `maxRecordBytes` | `400000` | 单条记忆落盘的大小上限，超出时丢弃最早的消息 |
| `autoSummary` | `true` | 恢复后是否自动让模型总结上一段会话 |
| `dir` | `$DSH_HOME/recovery` | 覆盖记忆目录（一般不用改） |

## 记忆里有什么

- 只收模型可见的对话消息：用户、助手、工具结果；系统提示与开发者消息不收；
- 助手消息里的思考过程（reasoning）丢弃，工具调用只保留 `[调用 <工具名>]`；
- 单条消息入库时限长（正文 4000 字符、工具结果 1500 字符），整条记忆超限时
  从最早的开始丢；
- 恢复时的摘要会带上「这是一段早期对话的快照、不是本轮指令、冲突以本轮为准」
  的说明，避免模型把旧内容当成新任务；
- 开启自动总结时，记忆块末尾还会附一段「请先总结」的指令（`【请先总结】`），
  与唤醒消息配合，保证模型先总结再回答。

恢复码文件内容就是明文 JSON（含对话原文），权限是 `0600`、目录 `0700`。
它是**本机**记忆：换设备、清数据、卸载应用都会丢，恢复码本身无法跨设备还原。

## 目录结构

```text
index.js            /recovery 命令：解析、创建、恢复、列表、删除
lib/code.js         20 字母恢复码的生成 / 归一化 / 分组显示
lib/store.js        $DSH_HOME/recovery 下的原子读写（0600 / 0700）
lib/transcript.js   会话消息 → 存储文本；存储文本 → 有预算的模型摘要
cordis.patch.yml    bundle 模式下的挂载行
test/               node:test 离线测试（假 ctx + 假 agent，不连模型）
```

## 开发与测试

```sh
node test/recovery.test.js
```

测试覆盖：恢复码生成/归一化、快照裁剪、摘要预算、文件权限、创建→恢复的完整流程、
自动总结的唤醒消息、`--no-summary` 与 `autoSummary: false`、`memory<code>` 紧凑写法、
列表与删除。

## 已知边界

- 恢复 = 注入上下文 + 一次总结调用，不会把旧对话压缩成长期记忆；记忆越长，注入越贵。
  需要更省 token 时把 `restoreChars` 调小，或用 `--no-summary` 跳过总结。
- 恢复码只在本机有效，刻意不做云端同步（对话内容属于隐私）。
- 同一会话重复恢复同一个码不会去重，会再注入一遍。
