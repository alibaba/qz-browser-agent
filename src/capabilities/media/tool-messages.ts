import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("media-tools", {
  screenshotDescription: {
    "zh-CN": "截取当前视口或指定元素的已渲染区域，并始终以图片形式返回给 LLM。需随后用 act_on_screen 按坐标操作时传 actionable=true（不可与 target 同用），返回的 coordinateSpace 给出原始像素宽高，可直接将图上坐标传给 act_on_screen。传 destination 时额外把截图保存为该图集表的 image asset；传 target 时截取该元素区域。{targetGrammar}。",
    en: "Capture the current viewport or the rendered region of a target element, and always return the image to the model. Pass actionable=true (cannot be combined with target) when you will act by coordinates with act_on_screen; the returned coordinateSpace gives the original pixel width and height. Pass destination to also save the capture as an image asset in that gallery table; pass target to capture a specific element. {targetGrammar}.",
  },
  screenshotTabId: {
    "zh-CN": "目标标签页 ID；省略时使用当前任务工作标签页（target 为 uid:... 时也可省略）。",
    en: "Target tab ID. Defaults to the current task's working tab (optional when target is uid:...).",
  },
  screenshotTarget: {
    "zh-CN": "元素截图目标（不可与 actionable=true 同用）。{targetDescription}",
    en: "Target for an element screenshot (cannot be combined with actionable=true). {targetDescription}",
  },
  screenshotIndex: {
    "zh-CN": "target 为 css:... 且匹配多个元素时的 0-based 序号，默认 0。",
    en: "0-based match index when a css:... target matches multiple elements. Default: 0.",
  },
  screenshotDestination: {
    "zh-CN": "可选图集表名；传入时将截图保存为该图集的 image asset。",
    en: "Optional gallery table name; when provided, saves the screenshot as an image asset in that gallery.",
  },
  screenshotFormat: {
    "zh-CN": "图片格式，默认 jpeg。",
    en: "Image format. Default: jpeg.",
  },
  screenshotQuality: {
    "zh-CN": "JPEG 质量（0–100），默认 70。",
    en: "JPEG quality (0–100). Default: 70.",
  },
  screenshotPadding: {
    "zh-CN": "元素截图四周外扩像素，默认 0，范围 0–200。",
    en: "Padding around an element screenshot in pixels. Default: 0; range: 0–200.",
  },
  screenshotMaxWidth: {
    "zh-CN": "返回图片最大宽度，默认及上限 2048；编码后不超过 2 MiB",
    en: "Maximum returned image width. Default and ceiling: 2048; encoded output is at most 2 MiB.",
  },
  screenshotMaxHeight: {
    "zh-CN": "返回图片最大高度，默认及上限 2048；编码后不超过 2 MiB",
    en: "Maximum returned image height. Default and ceiling: 2048; encoded output is at most 2 MiB.",
  },
  screenshotActionable: {
    "zh-CN": "是否将该视口截图作为后续 act_on_screen 的坐标依据，默认 false（不可与 target 同用）。",
    en: "Use this viewport screenshot as the coordinate basis for subsequent act_on_screen calls. Default: false (cannot be combined with target).",
  },
  actOnScreenDescription: {
    "zh-CN": "依据最近一次 screenshot(actionable=true) 或 act_on_screen(returnScreenshot:true) 建立的坐标状态，直接按屏幕坐标或当前焦点操作页面。x/y/endX/endY 使用返回截图左上角为原点的原始像素坐标，范围见 coordinateSpace.width/height。不带 x/y 时无需预先截图：press/type 操作当前焦点，scroll 在当前视口中心滚动；传 x/y 时按截图坐标定位，type 先点击再输入；replace=true 且 text 为空表示清空。调用必须串行并显式填写 returnScreenshot（true 返回操作后观察截图并刷新坐标空间；false 不截图并在页面未跳变时沿用原坐标空间）。viewportChange 客观记录浏览器视口变化，coordinateBasisReady 表示当前坐标空间能否继续使用。移动模式自动转为触摸（click/double_click/long_press/drag），不支持 hover 或右键/中键。",
    en: "Interact directly with the current task's page using the coordinate state established by the latest screenshot(actionable=true) or act_on_screen(returnScreenshot:true). x/y/endX/endY are original pixel coordinates measured from the top-left corner of the returned screenshot within coordinateSpace.width/height. Without x/y, no prior screenshot is needed: press/type act on the current focus and scroll scrolls at the viewport center; with x/y, actions target those screenshot coordinates and type clicks before typing; replace=true with empty text clears the field. Calls must be sequential and explicitly set returnScreenshot (true captures a post-action observation screenshot and refreshes the coordinate space; false skips capture and reuses the coordinate space while valid). viewportChange objectively records browser viewport changes; coordinateBasisReady indicates whether the current coordinate space remains usable. Mobile mode uses touch automatically (click/double_click/long_press/drag) and does not support hover or right/middle mouse buttons.",
  },
  actOnScreenReturnScreenshot: {
    "zh-CN": "必填。需要观察本次操作结果时传 true；已验证且无需逐步观察的连续操作传 false。",
    en: "Required. Pass true to observe the result of this action, or false for verified sequences that do not need observation after every step.",
  },
  actOnScreenX: {
    "zh-CN": "截图起点横坐标（像素，与 y 成对；click/double_click/long_press/hover/drag 必填，scroll 缺省取视口中心，press/type 可省略）。",
    en: "Starting x-coordinate in image pixels (paired with y; required for click/double_click/long_press/hover/drag, defaults to viewport center for scroll, optional for press/type).",
  },
  actOnScreenY: {
    "zh-CN": "截图起点纵坐标（像素，与 x 成对；click/double_click/long_press/hover/drag 必填，scroll 缺省取视口中心，press/type 可省略）。",
    en: "Starting y-coordinate in image pixels (paired with x; required for click/double_click/long_press/hover/drag, defaults to viewport center for scroll, optional for press/type).",
  },
  actOnScreenEndX: {
    "zh-CN": "drag 终点横坐标（像素）。",
    en: "Ending x-coordinate in image pixels for drag.",
  },
  actOnScreenEndY: {
    "zh-CN": "drag 终点纵坐标（像素）。",
    en: "Ending y-coordinate in image pixels for drag.",
  },
  actOnScreenText: {
    "zh-CN": "type 输入文本（replace=true 时传 \"\" 清空）。",
    en: "Text for type (pass \"\" with replace=true to clear).",
  },
  actOnScreenReplace: {
    "zh-CN": "type 前是否全选并替换现有内容，默认 false。",
    en: "Select all and replace existing content before typing. Default: false.",
  },
  actOnScreenKey: {
    "zh-CN": "press 按键名，如 Enter、Escape、Tab、Meta+A、Control+L。",
    en: "Key for press, such as Enter, Escape, Tab, Meta+A, or Control+L.",
  },
  actOnScreenButton: {
    "zh-CN": "鼠标按键（left/right/middle），默认 left。",
    en: "Mouse button (left/right/middle). Default: left.",
  },
  actOnScreenDurationMs: {
    "zh-CN": "long_press 毫秒数，默认 800，范围 300–5000。",
    en: "Duration of long_press in ms. Default: 800; range: 300–5000.",
  },
  actOnScreenDeltaX: {
    "zh-CN": "scroll 水平滚动像素（向右为正，范围 -10000–10000）。",
    en: "Horizontal scroll pixels (positive right, range -10000–10000).",
  },
  actOnScreenDeltaY: {
    "zh-CN": "scroll 垂直滚动像素（向下为正，范围 -10000–10000）。",
    en: "Vertical scroll pixels (positive down, range -10000–10000).",
  },
  actOnScreenRepeat: {
    "zh-CN": "scroll 连续滚轮次数，默认 1，范围 1–20。",
    en: "Consecutive wheel events for scroll. Default: 1; range: 1–20.",
  },
  listImagesDescription: {
    "zh-CN": "扫描目标页面中的图片候选，返回 alt、title、context（可访问名称/说明、图注、附近标题与正文、链接文本与 URL）、尺寸、位置、来源摘要，以及绑定当前 session、标签页、页面和图片地址的 target。在当前页面完成筛选后，将选中候选的 target 原样传给 read_image 或 collect_images；index/rank 仅用于阅读列表。",
    en: "Discover image candidates on the target page, returning alt, title, context (accessible name/description, caption, nearby heading and text, link text and URL), dimensions, position, source summary, and a target bound to the current session, tab, page, and image URL. Evaluate candidates in the current page context and pass selected targets unchanged to read_image or collect_images; index/rank are for reading the list only.",
  },
  listImagesTabId: {
    "zh-CN": "目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "Target tab ID. Defaults to the current task's working tab.",
  },
  listImagesSelector: {
    "zh-CN": "可选容器或 img 选择器；可传原始 CSS，也可传 target 格式 css:... / uid:...；省略时扫描整页。",
    en: "Optional container or img selector. Accepts raw CSS or a target in css:... / uid:... format; scans the whole page if omitted.",
  },
  listImagesMinWidth: {
    "zh-CN": "最小宽度（按显示宽度与 naturalWidth 较大值判断），默认 1。",
    en: "Minimum width (checked against the larger of displayed width and naturalWidth). Default: 1.",
  },
  listImagesMinHeight: {
    "zh-CN": "最小高度（按显示高度与 naturalHeight 较大值判断），默认 1。",
    en: "Minimum height (checked against the larger of displayed height and naturalHeight). Default: 1.",
  },
  listImagesVisibleOnly: {
    "zh-CN": "是否只列出可见图片，默认 true。",
    en: "List visible images only. Default: true.",
  },
  listImagesLimit: {
    "zh-CN": "最多返回图片数，默认 100，范围 1–1000。",
    en: "Maximum images to return. Default: 100; range: 1–1000.",
  },
  collectImagesDescription: {
    "zh-CN": "将已选定的页面图片（targets）或图片 URL（urls）保存为本地 image assets 并写入图集 Data 表（targets 与 urls 至少提供一项，单次合计最多 200 项）。页面候选须在离开或切换发现它的页面前及时采集；同一任务可多次调用并追加写入同一个 table。返回采集统计和 assetIds。",
    en: "Save selected page images (targets) or direct image URLs (urls) as local image assets and write metadata to a gallery Data table (provide at least one of targets or urls, up to 200 items total per call). Collect page candidates before leaving or switching away from the page where they were found; call repeatedly across tabs to append to the same table. Returns collection counts and assetIds.",
  },
  collectImagesTable: {
    "zh-CN": "必填。目标图集表名，用于持续写入及后续 data_store list / read_image_asset 复核。",
    en: "Required gallery table name, used for appending and subsequent verification via data_store list or read_image_asset.",
  },
  collectImagesTargets: {
    "zh-CN": "选中的页面图片 target 数组，原样传入 list_images 返回的 target。{targetDescription}",
    en: "Selected page image targets array; pass each target from list_images unchanged. {targetDescription}",
  },
  collectImagesUrls: {
    "zh-CN": "选中的直接图片 URL 数组（支持 http/https/data:image）。",
    en: "Selected direct image URLs array (supports http/https/data:image).",
  },
  collectImagesDedupField: {
    "zh-CN": "图集表 upsert 去重字段，默认 sourceKey。",
    en: "Deduplication field for gallery table upserts. Default: sourceKey.",
  },
  collectImagesMaxWidth: {
    "zh-CN": "读取/存储图片最大宽度，默认及上限 2048；编码后不超过 2 MiB。",
    en: "Maximum image width for reading/storage. Default and ceiling: 2048; encoded output is at most 2 MiB.",
  },
  collectImagesMaxHeight: {
    "zh-CN": "读取/存储图片最大高度，默认及上限 2048；编码后不超过 2 MiB。",
    en: "Maximum image height for reading/storage. Default and ceiling: 2048; encoded output is at most 2 MiB.",
  },
  collectImagesMaxBytes: {
    "zh-CN": "单张 URL 图片最大读取字节数，默认 20 MiB，最大 32 MiB；编码后图片不超过 2 MiB。",
    en: "Maximum bytes to read per URL image. Default: 20 MiB; maximum: 32 MiB. Encoded output is at most 2 MiB.",
  },
  collectImagesMaxImages: {
    "zh-CN": "本地 asset store 最大图片张数，默认 2000。",
    en: "Maximum images in the local asset store. Default: 2000.",
  },
  collectImagesMaxStorageBytes: {
    "zh-CN": "本地 asset store 最大总字节数，默认 1.5 GiB。",
    en: "Maximum total bytes in the local asset store. Default: 1.5 GiB.",
  },
  collectImagesFormat: {
    "zh-CN": "转码格式，默认 jpeg。",
    en: "Output image format. Default: jpeg.",
  },
  collectImagesQuality: {
    "zh-CN": "jpeg/webp 质量（0–1 或 1–100），默认 0.88。",
    en: "JPEG/WebP quality (0–1 or 1–100). Default: 0.88.",
  },
  readImagePrompt: {
    "zh-CN": "以上工具读取到的图片，请分析其视觉内容：",
    en: "Analyze the visual content of the images read by the tool above:",
  },
  readImageAssetDescription: {
    "zh-CN": "按 assetId 读取已保存在本地图集中的单张图片并作为图片消息返回给 LLM，用于抽检或复核已采集图片的视觉内容。",
    en: "Read a saved local image asset by assetId and return it to the model as an image message to inspect or verify collected images.",
  },
  readImageAssetAssetId: {
    "zh-CN": "collect_images、screenshot(destination) 或图集表行中的 assetId。",
    en: "assetId returned by collect_images, screenshot(destination), or a gallery table row.",
  },
  readImageAssetDetail: {
    "zh-CN": "视觉细节等级（low/auto/high），默认 auto。",
    en: "Vision detail level (low/auto/high). Default: auto.",
  },
  readImageDescription: {
    "zh-CN": "读取单张图片并作为图片消息返回给 LLM，url 或 target 二选一：传 target 读取页面已加载的 img/图片容器（满足采集条件时，在切换页面前将同一 target 传给 collect_images）；传 url 读取 http/https/data:image 图片地址。{targetGrammar}。",
    en: "Read an individual image and return it to the model as an image message. Provide either url or target: pass target to inspect a loaded page img/container (if selected for collection, pass the same target to collect_images before switching pages), or pass url to read an http/https/data:image resource. {targetGrammar}.",
  },
  readImageUrl: {
    "zh-CN": "图片 URL（支持 http/https/data:image）；传 url 时无需 tabId/target。",
    en: "Image URL (supports http/https/data:image); tabId and target are not needed when url is provided.",
  },
  readImageTarget: {
    "zh-CN": "页面 img 或图片容器的 target。{targetDescription}",
    en: "Target of a page img or image container. {targetDescription}",
  },
  readImageDetail: {
    "zh-CN": "视觉细节等级（low/auto/high），默认 auto。",
    en: "Vision detail level (low/auto/high). Default: auto.",
  },
  readImageMaxBytes: {
    "zh-CN": "URL 图片最大读取字节数，默认 20 MiB，最大 32 MiB；编码后图片不超过 2 MiB",
    en: "Maximum bytes to read from a URL image. Default: 20 MiB; maximum: 32 MiB. Encoded output is at most 2 MiB.",
  },
  readImageFormat: {
    "zh-CN": "转码格式，默认 png（png 可保留透明通道，避免透明背景转 jpeg 后变黑）。",
    en: "Output image format. Default: png (png preserves transparency and avoids black backgrounds on transparent images).",
  },
  readImageQuality: {
    "zh-CN": "jpeg/webp 质量（0–1 或 1–100），默认 0.88。",
    en: "JPEG/WebP quality (0–1 or 1–100). Default: 0.88.",
  },
  imageCandidatesGuidance: {
    "zh-CN": "已发现图片候选。在当前页面完成判断并把合格候选的 target 原样传给 read_image 或 collect_images；sourceOmitted 表示内嵌或超长地址已隐藏但仍绑定在 target 中。",
    en: "Image candidates found. Evaluate and pass selected targets unchanged to read_image or collect_images in the current page context; sourceOmitted means an embedded or long URL is omitted from text but remains bound to target.",
  },
  imageTargetRecovery: {
    "zh-CN": "重新调用 list_images，并原样使用某一个候选的 target。",
    en: "Call list_images again and use a candidate’s target unchanged.",
  },
  changedImageRecovery: {
    "zh-CN": "页面图片已变化，请重新调用 list_images 并选择新的 target。",
    en: "Page images have changed. Call list_images again and select a new target.",
  },
  collectTargetsRecovery: {
    "zh-CN": "调用 list_images，并把选中候选的 target 原样传入 targets。",
    en: "Call list_images and pass the selected candidates’ targets unchanged in targets.",
  },
  collectLimitRecovery: {
    "zh-CN": "减少本次明确选中的候选数量。",
    en: "Select fewer candidates for this call.",
  },
  collectionFailuresRecovery: {
    "zh-CN": "根据 failures 中的错误修正候选；页面 target 失效时重新调用 list_images，URL 失败时更换可直接访问的图片地址。",
    en: "Use the errors in failures to correct the candidates. For stale page targets, call list_images again; for failed URLs, choose directly accessible image URLs.",
  },
});

export const toolT = createTranslator(messages);
