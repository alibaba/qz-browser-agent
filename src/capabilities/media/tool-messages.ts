import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("media-tools", {
  screenshotDescription: {
    "zh-CN": "截图当前视口或指定元素的已渲染区域，并始终以图片形式返回给 LLM。需要随后按页面截图坐标操作时，传 actionable=true；返回的 coordinateSpace 会给出图片原始像素宽高，可直接把图上坐标交给 act_on_screen。传 destination 时会额外把截图保存为该图集的 image asset；不传 destination 则只返回图片不保存。元素级截图适合 read_image 因跨域 canvas 失败后的视觉兜底。{targetGrammar}。",
    en: "Capture the current viewport or the rendered region of a specified element, and always return the capture to the model as an image. Pass actionable=true if you will use screenshot coordinates for subsequent actions. The returned coordinateSpace gives the original image width and height in pixels, so coordinates from the image can be passed directly to act_on_screen. Providing destination also saves the capture as an image asset in that collection; otherwise the image is returned without being saved. Element screenshots provide a visual fallback when read_image fails because of cross-origin canvas restrictions. {targetGrammar}.",
  },
  screenshotTabId: {
    "zh-CN": "本次调用的目标标签页 ID；省略时使用当前任务工作标签页，target 为 uid:... 时可省略。",
    en: "Target tab ID for this call. Defaults to the current task’s working tab; may be omitted for a uid:... target.",
  },
  screenshotTarget: {
    "zh-CN": "元素级截图目标。{targetDescription}",
    en: "Target for an element screenshot. {targetDescription}",
  },
  screenshotIndex: {
    "zh-CN": "target 为 css:... 且匹配多个时的 index，默认 0",
    en: "Match index when a css:... target matches multiple elements. Default: 0.",
  },
  screenshotDestination: {
    "zh-CN": "可选图集表名。传入时把截图额外保存为该图集的 image asset；不传则不保存。",
    en: "Optional image collection table name. If provided, also saves the screenshot as an image asset in that collection; otherwise it is not saved.",
  },
  screenshotFormat: {
    "zh-CN": "默认 jpeg",
    en: "Default: jpeg.",
  },
  screenshotQuality: {
    "zh-CN": "JPEG 质量 0-100，默认 70",
    en: "JPEG quality from 0 to 100. Default: 70.",
  },
  screenshotPadding: {
    "zh-CN": "元素截图外扩像素，默认 0，最大 200",
    en: "Padding around an element screenshot in pixels. Default: 0; maximum: 200.",
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
    "zh-CN": "是否把当前视口截图作为下一次 act_on_screen 的坐标依据，默认 false；不能与 target 同用",
    en: "Whether to use the current viewport screenshot as the coordinate basis for the next act_on_screen call. Default: false. Cannot be combined with target.",
  },
  actOnScreenDescription: {
    "zh-CN": "依据最近一次 screenshot(actionable=true) 或 act_on_screen(returnScreenshot:true) 建立的坐标状态，直接操作当前任务页面，不查询 DOM。x/y/endX/endY 是返回页面截图上以左上角为原点的原始像素坐标，范围见 coordinateSpace.width/height。不带 x/y 时无需预先截图：press/type 操作当前焦点，scroll 在当前视口中心滚动；传 x/y 时按截图坐标定位，type 先点击再输入；replace=true 且 text 为空表示清空。调用必须串行并显式填写 returnScreenshot：需要观察本次结果时传 true；已验证且无需逐步观察的连续操作传 false。只有 true 才产生观察截图。结果中的 viewportChange 客观记录浏览器视口变化，coordinateBasisReady 表示当前坐标空间能否继续使用。run_script 返回内部最后一次 screenshot 或 act_on_screen(returnScreenshot:true) 的图片。long_press 会在指定位置持续按住后释放。移动模式自动使用触摸：click/double_click 为轻点/双击，long_press 为长按，drag 为手指滑动；scroll 仍表示滚动内容。移动模式不支持 hover 或鼠标右键/中键。",
    en: "Interact directly with the current task’s page using the coordinate state established by the latest screenshot(actionable=true) or act_on_screen(returnScreenshot:true), without querying the DOM. x/y/endX/endY are original image-pixel coordinates measured from the top-left corner of the returned page screenshot; see coordinateSpace.width/height for bounds. Without x/y, no prior screenshot is needed: press/type act on the current focus and scroll uses the current viewport center. Supplied x/y use screenshot coordinates; type clicks there before typing. replace=true with empty text clears the field. Calls must be sequential and explicitly include returnScreenshot: use true to observe the result, or false for verified sequences that do not need observation after every step. Only true produces an observation screenshot. viewportChange records browser viewport changes; coordinateBasisReady indicates whether the current coordinate space remains usable. run_script returns the image from its last screenshot or act_on_screen(returnScreenshot:true) call. long_press holds at the specified position and then releases. Mobile mode uses touch input automatically: click/double_click tap once/twice, long_press holds a finger down, and drag swipes between the endpoints. scroll still scrolls content. Hover and right/middle mouse buttons are unavailable in mobile mode.",
  },
  actOnScreenReturnScreenshot: {
    "zh-CN": "必须显式填写。需要观察本次操作结果时传 true；已验证且无需逐步观察的连续操作传 false",
    en: "Required. Use true to observe the result of this action, or false for verified sequences that do not need observation after every step.",
  },
  actOnScreenX: {
    "zh-CN": "返回图片上的起点横坐标（像素）；scroll 不填时使用当前视口中心，无需预先截图，press/type 可不填",
    en: "Starting x-coordinate in pixels on the returned image. scroll defaults to the current viewport center without a prior screenshot; optional for press/type.",
  },
  actOnScreenY: {
    "zh-CN": "返回图片上的起点纵坐标（像素）；scroll 不填时使用当前视口中心，无需预先截图，press/type 可不填",
    en: "Starting y-coordinate in pixels on the returned image. scroll defaults to the current viewport center without a prior screenshot; optional for press/type.",
  },
  actOnScreenEndX: {
    "zh-CN": "drag 在返回图片上的终点横坐标（像素）",
    en: "Ending x-coordinate for drag, in pixels on the returned image.",
  },
  actOnScreenEndY: {
    "zh-CN": "drag 在返回图片上的终点纵坐标（像素）",
    en: "Ending y-coordinate for drag, in pixels on the returned image.",
  },
  actOnScreenText: {
    "zh-CN": "type 要输入的文本；replace=true 时可传空字符串表示只清空",
    en: "Text to enter with type. With replace=true, an empty string clears the field.",
  },
  actOnScreenReplace: {
    "zh-CN": "type 前是否全选并替换当前内容，默认 false；与空 text 合用表示清空",
    en: "Whether type selects all and replaces existing content. Default: false. With empty text, clears the field.",
  },
  actOnScreenKey: {
    "zh-CN": "press 的按键，如 Enter、Escape、Tab、Meta+A、Control+L；不带 x/y 时无需预先截图",
    en: "Key for press, such as Enter, Escape, Tab, Meta+A, or Control+L. No prior screenshot is needed when x/y are omitted.",
  },
  actOnScreenButton: {
    "zh-CN": "click/double_click/long_press/drag 使用的鼠标键，默认 left",
    en: "Mouse button for click/double_click/long_press/drag. Default: left.",
  },
  actOnScreenDurationMs: {
    "zh-CN": "long_press 按住的毫秒数，默认 800，范围 300–5000",
    en: "Duration of long_press in milliseconds. Default: 800; range: 300–5000.",
  },
  actOnScreenDeltaX: {
    "zh-CN": "scroll 水平滚动像素，向右为正",
    en: "Horizontal scroll distance in pixels. Positive values scroll right.",
  },
  actOnScreenDeltaY: {
    "zh-CN": "scroll 垂直滚动像素，向下为正",
    en: "Vertical scroll distance in pixels. Positive values scroll down.",
  },
  actOnScreenRepeat: {
    "zh-CN": "scroll 在同一坐标连续发送的滚轮事件数，默认 1，最大 20",
    en: "Number of consecutive wheel events at the same coordinates. Default: 1; maximum: 20.",
  },
  listImagesDescription: {
    "zh-CN": "发现目标页面中的图片候选，只返回简短的 alt、title、可访问名称、说明文字、附近标题与正文、链接语义、尺寸、来源摘要和位置等元信息。每个候选都会返回绑定当前 session、标签页、页面和图片地址的 target；在该页面上下文中完成判断后，把合格候选的 target 原样交给 read_image 或 collect_images。index/rank 仅用于阅读候选列表。",
    en: "Discover image candidates on the target page. Returns only brief metadata: alt text, title, accessible name, captions, nearby headings and text, link context, dimensions, source summary, and position. Each candidate includes a target bound to the current session, tab, page, and image URL. Evaluate candidates in that page context, then pass selected targets unchanged to read_image or collect_images. index/rank are for reading the candidate list only.",
  },
  listImagesTabId: {
    "zh-CN": "本次调用的目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "Target tab ID for this call. Defaults to the current task’s working tab.",
  },
  listImagesSelector: {
    "zh-CN": "可选容器或 img CSS selector；也可传 target 格式 css:... / uid:...；不填扫描整个页面",
    en: "Optional container or img CSS selector, or a css:... / uid:... target. If omitted, scans the whole page.",
  },
  listImagesMinWidth: {
    "zh-CN": "最小图片宽度，按显示宽度或 naturalWidth 判断，默认 1",
    en: "Minimum image width, checked against displayed width or naturalWidth. Default: 1.",
  },
  listImagesMinHeight: {
    "zh-CN": "最小图片高度，按显示高度或 naturalHeight 判断，默认 1",
    en: "Minimum image height, checked against displayed height or naturalHeight. Default: 1.",
  },
  listImagesVisibleOnly: {
    "zh-CN": "是否只列出可见图片，默认 true",
    en: "Whether to list visible images only. Default: true.",
  },
  listImagesLimit: {
    "zh-CN": "最多返回多少张，默认 100，最大 1000",
    en: "Maximum number of images to return. Default: 100; maximum: 1000.",
  },
  collectImagesDescription: {
    "zh-CN": "采集已经选定的图片：保存为本地 image assets，并把元信息写入图集 Data 表。页面候选通过 targets 逐张指定，并在发现它们的当前页面上下文中及时采集；直接图片资源通过 urls 逐张指定，并按当前来源上下文采集。同一任务可多次调用并持续写入同一个 table。工具会在写入前解析全部 target，并核对候选页面和图片地址；返回摘要和 assetId。",
    en: "Collect selected images: save them as local image assets and write metadata to an image collection Data table. Specify page candidates individually with targets and collect them while still in the page context where they were discovered. Specify direct image resources individually with urls and collect them in the current source context. The same task can call this tool repeatedly to append to the same table. Before writing, the tool resolves all targets and verifies the candidate page and image URL. Returns a summary and assetId values.",
  },
  collectImagesTable: {
    "zh-CN": "图集表名，必填。用于稳定写入和后续 data_store list/read_image_asset 验证；极端缺失时 runtime 会自动生成随机图集名兜底。",
    en: "Required image collection table name. Use a consistent name for writes and subsequent verification with data_store list/read_image_asset. The runtime generates a random fallback name if this value is missing.",
  },
  collectImagesTargets: {
    "zh-CN": "选中页面图片的 target 列表。每项原样使用 list_images 返回的 target。{targetDescription}",
    en: "Targets of selected page images. Pass each target from list_images unchanged. {targetDescription}",
  },
  collectImagesUrls: {
    "zh-CN": "选中图片的直接 URL 列表，支持 http/https/data:image。",
    en: "Direct URLs of selected images. Supports http/https/data:image.",
  },
  collectImagesDedupField: {
    "zh-CN": "图集表 upsert 去重字段，默认 sourceKey。",
    en: "Deduplication field for upsert into the collection table. Default: sourceKey.",
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
    en: "Maximum number of images in the local asset store. Default: 2000.",
  },
  collectImagesMaxStorageBytes: {
    "zh-CN": "本地 asset store 最大总字节数，默认 1.5 GiB。",
    en: "Maximum total bytes in the local asset store. Default: 1.5 GiB.",
  },
  collectImagesFormat: {
    "zh-CN": "页面侧转码格式，默认 jpeg。",
    en: "Image format for conversion in the page. Default: jpeg.",
  },
  collectImagesQuality: {
    "zh-CN": "jpeg/webp 质量，0-1 或 1-100，默认 0.88。",
    en: "JPEG/WebP quality, from 0–1 or 1–100. Default: 0.88.",
  },
  readImagePrompt: {
    "zh-CN": "以上工具读取到的图片，请分析其视觉内容：",
    en: "Analyze the visual content of the images read by the tool above:",
  },
  readImageAssetDescription: {
    "zh-CN": "读取已保存的本地图片 asset，并作为图片消息返回给 LLM。适合从 collect_images 采集后的图集中挑选少量图片做视觉分析。",
    en: "Read a saved local image asset and return it to the model as an image message. Useful for visually analyzing a small selection from a collection created by collect_images.",
  },
  readImageAssetAssetId: {
    "zh-CN": "collect_images 返回或图集表中的 assetId。",
    en: "assetId returned by collect_images or stored in the collection table.",
  },
  readImageAssetDetail: {
    "zh-CN": "传给视觉模型的图片细节等级，默认 auto。",
    en: "Image detail level sent to the vision model. Default: auto.",
  },
  readImageDescription: {
    "zh-CN": "读取图片并作为图片消息返回给 LLM，url 或 target 二选一。传 url 读取图片资源；传页面 img 或图片容器的 target 读取已经加载的 DOM 图片。页面候选满足采集条件时，在切换页面上下文前把同一个 target 交给 collect_images。用于分析单张图片的视觉内容。{targetGrammar}。",
    en: "Read an image and return it to the model as an image message. Provide either url or target. Use url to read an image resource, or the target of a page img/image container to read an already loaded DOM image. If a page candidate meets the collection criteria, pass the same target to collect_images before switching page context. Use to analyze the visual content of an individual image. {targetGrammar}.",
  },
  readImageUrl: {
    "zh-CN": "图片 URL。支持 http/https/data:image。传 url 时不需要 tabId/target。",
    en: "Image URL. Supports http/https/data:image. tabId/target are not needed when url is provided.",
  },
  readImageTarget: {
    "zh-CN": "页面 img 或图片容器目标。{targetDescription}",
    en: "Target of a page img or image container. {targetDescription}",
  },
  readImageDetail: {
    "zh-CN": "传给视觉模型的图片细节等级，默认 auto",
    en: "Image detail level sent to the vision model. Default: auto.",
  },
  readImageMaxBytes: {
    "zh-CN": "URL 图片最大读取字节数，默认 20 MiB，最大 32 MiB；编码后图片不超过 2 MiB",
    en: "Maximum bytes to read from a URL image. Default: 20 MiB; maximum: 32 MiB. Encoded output is at most 2 MiB.",
  },
  readImageFormat: {
    "zh-CN": "页面侧转码格式，默认 png。png 可保留透明通道，避免透明图片转 jpeg 后变黑。",
    en: "Image format for conversion in the page. Default: png. PNG preserves transparency, avoiding black backgrounds when transparent images are converted to JPEG.",
  },
  readImageQuality: {
    "zh-CN": "jpeg/webp 质量，0-1 或 1-100，默认 0.88",
    en: "JPEG/WebP quality, from 0–1 or 1–100. Default: 0.88.",
  },
  imageCandidatesGuidance: {
    "zh-CN": "已发现图片候选。在该页面上下文中完成判断和采集；把合格候选的 target 原样传给 read_image 或 collect_images。sourceOmitted 表示来源是内嵌图片或地址过长，完整来源仍安全绑定在 target 内部。",
    en: "Image candidates found. Evaluate and collect them in the current page context; pass selected targets unchanged to read_image or collect_images. sourceOmitted means the source is embedded or its URL is too long; the full source remains securely bound to the target.",
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
