
# Walioss
基于 Wails 的阿里云 OSS 桌面客户端，使用 `ossutil` 驱动列举/上传/下载。支持多标签页、快捷键、书签与上传下载队列。

## 功能
- 连接 OSS：登录后持久化配置，未保存的临时连接不产生书签历史。
- 文件浏览：桶与前缀导航、面包屑、文件类型识别，右键或行内操作支持下载/删除。
- 上传下载：顶部 ⇅ 面板显示进行中的传输，失败/成功状态可见。
- 书签：针对当前配置保存路径，类似浏览器收藏，按配置隔离。
- 标签页：可新建/关闭/重命名，编号徽标显示顺序，快捷键快速切换。
- 主题与设置：支持亮/暗主题，设置 ossutil 路径。

## 前置依赖
- Go 1.21+
- Node.js 18+ 与 pnpm
- ossutil v2（需可执行权限；可放在 `bin/ossutil` 或系统 PATH 中）
- Wails CLI `npm install -g wails@v2`（或参考官方安装）

## 开发/运行
```bash
wails dev          # 开发调试
```
首次运行会 `pnpm install` 前端依赖并生成 bindings。

## 构建
```bash
wails build       # 生成桌面应用
```

## 快捷键
- Cmd/Ctrl+T：新建标签页
- Cmd/Ctrl+W：关闭当前标签页
- Cmd/Ctrl+1..9：切换到对应序号标签
- 标签标题双击可重命名

## 说明
- 书签存储于本地（每个已保存配置独立），临时连接不可用。
- 下载/上传操作通过 `ossutil cp`，如遇权限或网络异常，请检查凭证与网络。
- 需要自定义 `ossutil` 路径可在设置中填写。

## 致谢
- [ossutil v1](https://github.com/aliyun/ossutil)
- [ossutil v2](https://www.alibabacloud.com/help/en/oss/developer-reference/ossutil-overview/)
- [oss-browser v1](https://github.com/aliyun/oss-browser)
- [oss-browser v2](https://help.aliyun.com/zh/oss/developer-reference/ossbrowser-2-0-overview/)
