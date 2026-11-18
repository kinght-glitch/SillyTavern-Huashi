# 画师（Huashi）· 剧情生图插件

给酒馆 SillyTavern 加一个 🎨 按钮：一键把当前剧情画出来。

点击任意 AI 回复右下角的 🎨 → 插件自动采集三层上下文（玄黄数据库 / 世界书 / 最近聊天）→ LLM 把剧情翻译成 danbooru 标签 → 本地 SD WebUI 出图 → 图片自动回贴到聊天里，提示词可展开查看复制。

## 功能一览

- 一键出图：点 🎨 等 1~2 分钟，图自动回贴，无需任何手动操作
- 三层上下文：玄黄数据库（人物/地点/外观）+ 世界书 + 最近聊天，剧情细节自动进画
- LLM 翻译：剧情 → danbooru 标签（正向/负向分开），比手搓提示词更贴剧情
- 自动降级：LLM 不可用时，用被点消息原文直接出图，链路不中断
- NSFW 联动：跟随酒馆 NSFW 档位自动调整负向标签
- 提示词面板：回贴消息下方可展开查看 / 复制完整正负标签
- 设置齐全：画幅、步数、CFG、采样器、Clip skip、VAE、采集开关、Token 预算均可调

## 环境要求

| 组件 | 要求 |
| --- | --- |
| 酒馆 SillyTavern | 1.11+（1.19 实测通过） |
| Stable Diffusion WebUI | A1111（v4.11.1 实测），需以 --api 模式启动 |
| LLM 接口 | 任意 OpenAI 兼容接口（默认配置为 https://api.jiuzhan.top/v1 + deepseek-v4.1-flash，可在设置里更换） |

LLM 只用于翻译剧情→标签，每次出图约 1 次调用（¥0.02 级）。不配置 LLM 也能出图（自动降级为原文直出）。

## 安装步骤

1. 下载本插件 zip 并解压，得到「画师」文件夹
2. 关闭酒馆
3. 把「画师」文件夹整个复制到酒馆的 data/default-user/extensions/ 目录下，最终路径形如：

`SillyTavern/data/default-user/extensions/画师/`

   （只新增这一个目录，不覆盖任何已有文件）
4. 启动 SD（运行 SD 目录下的 启动API.bat，等黑窗口出现 Running on local URL）
5. 启动酒馆 → 顶部「扩展程序」面板 → 勾选「画师」
6. 打开插件设置面板，点「测试 SD」确认 7860 连通；点「测试 LLM」确认翻译链路（一次 ¥0.02）
7. 回到聊天，点任意 AI 回复右下角的 🎨 开画

## 使用说明

- 出图：点 AI 回复右下角 🎨 按钮，等待生成（512×768 / 20 步约 1 分钟级），图片自动回贴到该消息之后
- 看提示词：回贴消息下方有「提示词」折叠面板，展开可查看并复制正向 / 负向标签
- 出图期间切换了聊天：图片只保存到本地，不会回贴错聊天
- 设置面板各项：

| 设置项 | 说明 | 默认 |
| --- | --- | --- |
| LLM 地址 / 模型 | 翻译剧情用的 OpenAI 兼容接口 | https://api.jiuzhan.top/v1 / deepseek-v4.1-flash |
| SD 地址 | 本地 SD WebUI 地址 | http://127.0.0.1:7860 |
| 画幅 | 出图尺寸 | 512×768 |
| 步数 / CFG / 采样器 | 出图质量参数 | 20 / 7 / DPM++ 2M Karras |
| Clip skip / VAE | 模型相关 | 2 / 空（自动） |
| 聊天条数 / Token 预算 | 喂给 LLM 的上下文量 | 3 / 6000 |
| 三层开关 | 数据库 / 世界书 / 聊天，控制采集哪些上下文 | 全开 |
| NSFW 联动 | 跟随酒馆 NSFW 档位调整负向标签 | 开 |
| 破甲继承 | 继承角色卡中的破甲预设词 | 开 |

## 图片保存位置

聊天内图片：SillyTavern/data/default-user/user/images/角色名/huashi_时间戳.png

SD 存档：SD 的 outputs/txt2img-images/日期/ 目录（v1.0.2 起强制落盘）

## 常见问题

- 点 🎨 报「SD 未启动」：运行 SD 目录的 启动API.bat，等出现 Running on local URL 再点「测试 SD」
- 出图了但 SD outputs 里没有：升级到 v1.0.2+（已修复 A1111 API 默认不保存的问题）
- 图是乱画的 / 不像剧情：先点「测试 LLM」确认翻译链路正常；或调大 Token 预算
- 提示词面板为空：LLM 两次解析失败会降级为原文出图，此时提示词=原文摘要
- 想换 LLM：设置里改地址+模型即可，任何 OpenAI 兼容接口都行（含中转站）

## 下载

- 插件包（推荐，解压即得「画师」文件夹）：https://github.com/kinght-glitch/SillyTavern-Huashi/releases/download/v1.0.2/huashi-v1.0.2.zip
- 最新 Release 页：https://github.com/kinght-glitch/SillyTavern-Huashi/releases/latest
- 源码包（v1.0.2）：https://github.com/kinght-glitch/SillyTavern-Huashi/archive/refs/tags/v1.0.2.zip

## 许可

MIT License。作者：大肥鱼
