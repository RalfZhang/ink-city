# InkCity 任务清单

> 项目背景与设计决策见 [idea.md](idea.md)。
> 这份文件是落地执行的任务列表，跟着勾就行。

## 技术栈（已敲定）
- **桌面框架**：Tauri 2（Rust + Web）
- **前端**：React + TypeScript + Vite
- **选城策略**：确定性偏移 `(today - 2023-03-03) % 1000`
- **地图渲染**：隐藏 WebView + Canvas 截图为 PNG
- **降级**：Overpass 多镜像重试 → 全部失败保留昨日壁纸

## MVP（核心闭环：列表 → 选今日 → 拉 OSM → 渲染 PNG → 设壁纸）

- [x] 1. 脚手架：`npm create tauri-app` 选 React+TS+Vite
- [ ] 2. `scripts/build-cities.ts`：下载 GeoNames cities1000，按人口降序取前 1000，输出 [src/data/cities.json](src/data/cities.json)
- [ ] 3. [src/lib/city.ts](src/lib/city.ts)：`pickCityForDate(date)`，纪元 `2023-03-03`
- [ ] 4. [src/lib/bbox.ts](src/lib/bbox.ts)：20km 边界数学（lat 用 1°≈111.32km，lon 用 cos 校正）
- [ ] 5. [src-tauri/src/overpass.rs](src-tauri/src/overpass.rs)：镜像列表（overpass-api.de / kumi.systems / overpass.private.coffee）+ 90s 超时 + 顺序回退
- [ ] 6. [src/renderer/render.html](src/renderer/render.html) + [src/renderer/render.ts](src/renderer/render.ts)：监听事件接收 `{osm, bbox, size, style}` → 画 canvas → `toBlob` → `invoke('save_png', bytes)`
- [ ] 7. [src-tauri/src/wallpaper.rs](src-tauri/src/wallpaper.rs)：用 `wallpaper` crate 设置壁纸
- [ ] 8. [src-tauri/src/scheduler.rs](src-tauri/src/scheduler.rs)：启动时补漏 + 午夜 tick（tokio）
- [ ] 9. [src-tauri/src/pipeline.rs](src-tauri/src/pipeline.rs)：编排 + cache（`<date>.osm.json` / `<date>.png`，保留最近 7 天）
- [ ] 10. 最小 UI：今日城市名 + 国家 + "立刻重新生成" + 启用/禁用开关
- [ ] 11. 验证：手动跑通验证清单（见底部）

## Post-MVP（迭代）

- [ ] 设置页四个 Tab：常规 / 样式 / 关于 / 反馈
- [ ] 主题：Dark / Light / 跟随系统（监听系统主题变化）
- [ ] 自定义前景色 / 背景色 + 双模式各一套默认值 + "恢复默认"
- [ ] 多语言（i18next，至少 en / zh / ja / ko / de / fr / es）
- [ ] 自启动（`tauri-plugin-autostart`）
- [ ] 系统托盘 + 菜单：打开设置 / 启停 / 退出
- [ ] 隐藏托盘图标选项
- [ ] "关于"页：项目介绍 + GitHub 链接 + Wikipedia 按钮
- [ ] "反馈"页：跳转 GitHub Issues
- [ ] 城市列表远端热更新（GitHub Raw / jsDelivr）+ ETag 缓存
- [ ] 渲染样式预设（线宽、不同 road type 配色）
- [ ] 关闭按钮行为：完全退出 vs 隐藏到托盘

## 关键外部依赖

- Rust：[`wallpaper`](https://crates.io/crates/wallpaper)、`reqwest`、`tokio`、`serde_json`、`chrono`
- 数据：[GeoNames cities1000](https://download.geonames.org/export/dump/cities1000.zip)（CC BY 4.0）
- Overpass 镜像：`overpass-api.de` / `kumi.systems` / `overpass.private.coffee`
- 渲染参考：[anvaka/city-roads](https://github.com/anvaka/city-roads)

## MVP 验证清单

- [ ] 启动后设置页显示今日城市名（与离线手算 `(today - 2023-03-03) % 1000` 一致）
- [ ] 点"立即重新生成" → 几秒内桌面壁纸切换为道路图
- [ ] 系统设置 → 壁纸 中文件路径在 app cache dir
- [ ] 关闭再启动应用：今日已生成则不重复生成
- [ ] 离线点击"重新生成"：所有镜像失败 → 旧壁纸保留 + 日志记录
- [ ] 系统时间手动改到次日 00:00：自动触发新一轮
- [ ] 关闭/打开应用开关：关闭时不再触发定时
