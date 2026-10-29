export function imageTranscript() {
  const runId = "markdown-stream-run";
  const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#638f87"/></svg>');
  const places = ["湖边楼阁", "历史木造舞台", "山间鸟居", "溪流和山景", "庭院"];
  const pages = ["Lakeside_Pavilion", "Historic_Wooden_Stage", "Gates_on_the_Mountain", "River_and_Mountains", "Garden"];
  return [
    { type: "user", text: "采集五处景点的图片", clientMessageId: "image-user" },
    ...["open_tab", "run_script", "collect_images", "data_store", "run_script", "read_image_asset"].map((name, i) => ({
      type: "tool", name, toolCallId: `image-tool-${i}`, runId, args: {}, phase: "done", isRunning: false,
      result: name === "collect_images" ? { table: "landmark_images", collected: 5, inserted: 5, updated: 0, totalRows: 5,
        images: places.map(alt => ({ src: image, alt })) } : { ok: true },
    })),
    { type: "assistant", runId, spanId: "image-answer", content: [
      "图片已核对无误，采集结果如下。", "", "## 交付结果", "",
      "已保存五处景点的图片及来源，可在图集中查看。", "",
      "| # | 景点 | 图片尺寸 | 来源条目 |", "|---|---|---|---|",
      ...places.map((name, i) => `| ${i + 1} | ${name} | 2048×1365（原图 5184×3456） | [${pages[i]}](https://example.com/encyclopedia/landmarks/${pages[i]}) |`),
      "", "图片与来源已核对，全部保存完毕。", "", "来源：",
      ...pages.map((name, i) => `[^${i + 1}]: [${name}](https://example.com/encyclopedia/landmarks/${name})`),
    ].join("\n") },
  ];
}
