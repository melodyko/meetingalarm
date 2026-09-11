# 会议铃 V7.8

按组隔离的会议室管理与展示看板，包含浏览屏、组管理员和超级管理员三类页面。

## 地址

- 超级管理员：`/tools/work/meeting-alarm/superadmin`
- 分组展示屏：`/tools/work/meeting-alarm/group/{组别标识}`
- 分组管理页：`/tools/work/meeting-alarm/group/{组别标识}/admin`

## 生产环境配置

应用启动前需要在服务器进程中提供以下环境变量：

```text
SUPER_ADMIN_PASSWORD=请设置超级管理员密码
SESSION_SECRET=请设置一个至少32位的随机字符串
GROUP_ADMIN_INITIAL_PASSWORD=首次创建数据文件时好车主组使用的初始密码
MEETING_DATA_FILE=C:\wwwroot\huiyishi\board\data\meeting-board.json
SMTP_HOST=smtp.163.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=meetingalarm@163.com
SMTP_PASS=163邮箱客户端授权码
SMTP_FROM=会议铃 <meetingalarm@163.com>
VOICE_AGENT_ENDPOINT=外部语音Agent接口地址
VOICE_AGENT_API_KEY=外部语音Agent密钥
VOICE_AGENT_MODEL=可选的模型名称
```

- `SUPER_ADMIN_PASSWORD` 只在服务端校验。
- `SESSION_SECRET` 用于签署管理员登录凭证，生产环境必须使用独立随机值。
- `GROUP_ADMIN_INITIAL_PASSWORD` 仅在数据文件首次创建时使用；之后可在组管理页修改，或由超级管理员重置。
- `data\meeting-board.json` 保存全部组别数据，请加入服务器备份。
- 分组密码以 PBKDF2 摘要保存，不会写入浏览器代码或接口响应。
- 邮件扫描由展示屏每分钟的数据请求触发；同一场会议只会成功发送一次。
- 语音录入通过本站后端转发，`VOICE_AGENT_API_KEY` 不会下发到浏览器。接口未配置时语音按钮保持禁用。
- iPad 麦克风录音需要通过 HTTPS 访问站点，并在首次使用时允许麦克风权限。

## V7 功能

- 新增会议支持录音并由外部 Agent 生成会议草稿，管理员确认后再保存。
- 人员名单支持 UTF-8 CSV 导入和导出，可直接使用 Excel 打开与另存。
- 测试邮件提供发送中、成功和失败 Toast 状态。

## V7.1 展示屏适配

- iPad mini 横竖屏采用独立断点，周视图支持横向滑动和吸附定位。
- 手机端会议时间线改为卡片布局，避免会议名称、地点和时长相互挤压。
- 手机提醒弹窗改为全屏模式，关闭与确认按钮均扩大为触控友好的尺寸。
- 支持刘海屏安全区域，并为不支持 Flex Gap 的旧版 iOS Safari 提供布局降级。

## V7.2 声音控制

- 展示屏将声音开关和声音测试拆分为两个按钮。
- 页面刷新后声音开关自动恢复开启，降低展示屏被静音后无人发现的风险。
- iPad/Safari 首次访问仍需点击一次“测试声音”，完成浏览器的声音播放授权。

## V7.3 小屏紧凑模式

- 手机顶部品牌栏、日期导航和北京时间改为紧凑布局。
- 下一场提醒在窄屏上恢复单行结构，减少进入会议列表前的占屏高度。
- 保留声音、测试和全屏按钮的独立入口。

## V7.4 窄屏会议卡片

- 状态、会议名称和提醒标记合并到同一行。
- 时间、会议室、发起人和会议类型重新聚合，减少卡片空白。
- 时长只展示一次，不再重复显示会议类型。

## V7.5 邮件收件人名称

- 邮件收件人改为标准的“中文姓名 + 邮箱地址”结构。
- 中文姓名由邮件库按 RFC 规范编码，避免收件人邮件头出现乱码。
- 自动清理姓名中的换行符，防止异常字符破坏邮件头。

## V7.6 会议提醒文案

- 邮件标题区改为中文“会议提醒”。
- 正文使用会议申请人、日期、时间和会议室信息生成提醒。
- 增加三条会议室使用建议，并在 HTML 邮件中使用提示框集中展示。
- 管理页的邮件模板预览与实际邮件内容保持一致。

## V7.7 iPad mini 3 兼容

- 客户端脚本降级编译到 Safari 12，兼容 iPad mini 3 的 iOS 12.5.8。
- 修复旧设备仅显示服务端占位内容、日期停留在 1 月 1 日、时间与会议数据不更新的问题。
- 人员名单 CSV 导出移除旧 Safari 不支持的 `String.replaceAll` 调用。

CSV 文件使用以下表头：

```csv
姓名,邮箱
张三,zhangsan@example.com
李四,lisi@example.com
```

导入采用合并方式：同名成员更新邮箱，其他成员新增，不会删除现有名单。

## 构建

需要 Node.js 22.13 或以上版本：

```bash
npm ci
npm run build
npm run start
```
