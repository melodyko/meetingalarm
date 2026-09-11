# 会议铃 V7.7 发布说明

V7.7 修复 iPad mini 3（iOS 12.5.8）无法执行展示页客户端脚本的问题，不改变会议数据和管理功能。

## 问题表现

- 日期固定显示为 1 月 1 日。
- 北京时间显示为占位符。
- 会议统计为 0，列表不随服务器数据更新。
- 页面外观可以显示，但声音、刷新和提醒等交互没有启动。

## 本次更新

- 将浏览器端 JavaScript 编译目标调整为 Safari 12。
- 自动转换旧 Safari 无法解析的可选链和空值合并等现代语法。
- 在客户端主脚本之前补齐 iOS 12 缺失的 `globalThis`、`Object.hasOwn`、`String.replaceAll` 和 `String.matchAll`。
- CSS 同步使用 Safari 12 构建目标，并保留现有旧版布局降级。
- CSV 导出不再使用 iOS 12 不支持的 `String.replaceAll`。

升级后请在 iPad 的 Safari 设置中清除该站点的缓存，或关闭原标签页后重新打开，避免继续使用 V7.6 的旧脚本文件。
