# dsh-recovery

给 DeepSeek Harness 用的「对话记忆恢复」插件：

- `/recovery create` —— 把当前对话打包成一条记忆，生成 **20 个字母的恢复码**；
- `/recovery memory <恢复码>` —— 在任意新对话里凭恢复码把这记忆注入回去，模型立刻接上之前的上下文。

记忆保存在本机 `$DSH_HOME/recovery/` 下，一个恢复码一个文件；不上传、不同步。

## 更改记忆路径（三步）

记忆默认保存在 `$DSH_HOME/recovery/`。要换到共享存储、同步盘或外置卡：

1. 在 profile 的 `cordis.patch.yml` 里给 `dsh-recovery` 加上 `dir`：

   ```yaml
   - insert:
       - id: dsh-recovery
         name: dsh-recovery
         config:
           dir: /storage/emulated/0/Download/dsh-recovery
   ```

2. 把旧目录里的 `*.json` 拷到新目录（不拷的话，旧恢复码在新位置找不到）；
3. 重启引擎。之后 `/recovery where` 会显示新目录、来源和可用状态。

也支持环境变量 `DSH_RECOVERY_DIR`（优先级：配置 `dir` > 环境变量 > 默认）。
`~/xxx` 展开到系统 home，相对路径按 `$DSH_HOME` 解析。

完整说明见 [记忆存在哪里 / 换到别的位置](#换到别的位置)。

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
3. 恢复完成后，模型会**自动先总结一遍**那段会话（在做什么、各步结论、涉及的文件/命令、
   遗留事项），要求尽量保留关键信息而不是只挑几条；回复最后一行是「记忆已恢复」。
   然后你再接着提问即可。

`/recovery memory` 做两件事：

1. 把记忆**注入上下文**（不直接触发回复的那种）；
2. 再发一条唤醒消息，让模型先按顺序梳理这段会话 —— 这就是「自动总结上一段会话」，
   并要求它在回复最后单独一行写「记忆已恢复」。

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
        restoreChars: 48000
        maxRecordBytes: 4000000
        autoSummary: true
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

> 插件本体挪了位置（比如把 `dsh-recovery/` 从 workspaces 移到别处）时，还要同步改
> profile `package.json` 里的 `link:` 路径并重建 `node_modules/dsh-recovery` 符号链接，
> 否则启动会报模块找不到。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `restoreChars` | `48000` | 恢复时注入的字符预算。**装得下就完整注入**；装不下才保留开头 35% + 结尾 65%，并注明剩余条目仍在本机记录里 |
| `maxRecordBytes` | `4000000` | 单条记忆落盘的大小上限（约 4 MB），正常对话不会被裁剪 |
| `autoSummary` | `true` | 恢复后是否自动让模型总结上一段会话 |
| `dir` | `$DSH_HOME/recovery` | 记忆目录，可指向共享存储/同步盘；支持 `~/` 与相对 `$DSH_HOME` 的路径 |

环境变量 `DSH_RECOVERY_DIR` 也能指定目录，优先级是：配置 `dir` > 环境变量 > 默认。

## 记忆存在哪里

默认在 `$DSH_HOME/recovery/`，本机就是：

```text
/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/recovery/
```

（`/data/data/com.dsharnessmobile.shell/...` 是同一目录的另一个别名。）

每个恢复码一个 JSON 文件，权限 `0600`、目录 `0700`。`/recovery where` 可以随时查看
当前目录、是否可写、有几条记录。

## 换到别的位置

优先级：配置 `dir` > 环境变量 `DSH_RECOVERY_DIR` > 默认。

在 profile 的 `cordis.patch.yml` 里改：

```yaml
- insert:
    - id: dsh-recovery
      name: dsh-recovery
      config:
        dir: /storage/emulated/0/Download/dsh-recovery
```

- 绝对路径直接使用；`~/xxx` 展开到系统 home；相对路径按 `$DSH_HOME` 解析；
- 目录在插件启动时解析一次，**改完要重启引擎**；
- 已有记录不会自动搬家：把旧目录里的 `*.json` 拷进新目录即可继续用原来的恢复码。

常见落点：

| 想放哪 | `dir` 示例 | 说明 |
|---|---|---|
| 共享存储（文件管理器可见、可备份） | `/storage/emulated/0/Download/dsh-recovery` | 本机实测可写；但 `0600` 会退化为 `0660` |
| 同步盘（跨设备） | `~/Sync/dsh-recovery` | 依赖同步工具覆盖该目录；另一台设备要装同一插件并指向同步后的路径 |
| 外置 SD 卡 | `/storage/XXXX-XXXX/dsh-recovery` | 需要该卷对应用可写 |

⚠️ 放到共享存储/同步盘后，记忆仍是明文 JSON，能读该目录的其他应用也能看到内容；
隐私优先的对话建议留在默认目录。

## 记忆里有什么

- 只收模型可见的对话消息：用户、助手、工具结果；系统提示与开发者消息不收；
- 助手消息里的思考过程（reasoning）丢弃，工具调用只保留 `[调用 <工具名>]`；
- **默认不做压缩**：正常长度的消息整条入库、整条注入，恢复块里是完整对话；
  只有单条消息异常长（正文 > 10 万字符、工具结果 > 2 万字符）才会截断；
- 整条记忆超过 `restoreChars` 时才退化成「开头 + 结尾」，中间省略的条目**仍在
  磁盘的完整记录里**，块里会写明 `本次载入 X/Y 条；其余 N 条仍在本机的完整记录里`；
- 恢复块会带上「这是一段早期对话的快照、不是本轮指令、冲突以本轮为准」的说明，
  避免模型把旧内容当成新任务；
- 恢复块的最后一行固定是 `记忆已恢复。`；开启自动总结时，块内还会附
  「请先总结」指令（`【请先总结】`）并要求模型**在自己回复的最后单独一行也写
  `记忆已恢复`**，与唤醒消息配合。

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

测试覆盖：恢复码生成/归一化、超长消息完整保留、超预算时的省略提示、文件权限、
创建→恢复的完整流程、结尾的「记忆已恢复」、自动总结的唤醒消息、`--no-summary` 与
`autoSummary: false`、`memory<code>` 紧凑写法、列表与删除。

## 已知边界

- 默认按完整对话注入，长对话会明显更贵；需要省 token 时把 `restoreChars` 调小
  （此时才退化成开头 + 结尾），或用 `--no-summary` 跳过总结。
- 完整记录始终在 `$DSH_HOME/recovery/`，恢复块被预算截断不会删除磁盘上的内容。
- 恢复码只在本机有效，刻意不做云端同步（对话内容属于隐私）。
- 同一会话重复恢复同一个码不会去重，会再注入一遍。
