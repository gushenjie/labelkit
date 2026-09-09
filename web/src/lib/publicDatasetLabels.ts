/** 公开数据导入流程状态（面向国内用户的展示文案） */
export const PUBLIC_IMPORT_STATE_ZH: Record<string, string> = {
  created: "已创建",
  fetching: "下载分析中",
  fetched: "待确认导入",
  fetch_failed: "下载失败",
  fetch_interrupted: "下载中断",
  publishing: "导入中",
  publish_interrupted: "导入中断",
  needs_label: "待标注",
  review: "抽样复查",
  review_expanded: "扩大抽样",
  full_review_required: "需全量复查",
  published: "已导入",
  training: "训练中",
  completed: "已完成",
  discarded: "已放弃",
};

export const DATASET_FORMAT_ZH: Record<string, string> = {
  yolo_detect: "YOLO 目标检测",
  yolo_classify: "YOLO 分类",
  coco: "COCO",
  voc: "Pascal VOC",
};

export function formatPublicImportState(state: string): string {
  return PUBLIC_IMPORT_STATE_ZH[state] ?? state;
}

export function formatDatasetFormat(format: string): string {
  return DATASET_FORMAT_ZH[format] ?? format;
}

/** 有标注时是否所有来源类别都被映射为忽略 */
export function allSourceLabelsIgnored(
  mapping: Record<string, number | null>,
  sourceClasses: Array<{ class_id: number }>,
  annotationCount: number,
): boolean {
  if (annotationCount <= 0 || sourceClasses.length === 0) return false;
  return sourceClasses.every((item) => mapping[String(item.class_id)] == null);
}

export function classMappingSelectValue(mapping: Record<string, number | null>, sourceClassId: number): string {
  const mapped = mapping[String(sourceClassId)];
  return mapped == null ? "ignore" : String(mapped);
}

const compactNumberFormatter = new Intl.NumberFormat("zh-CN");

/** 公开数据集任务类型展示 */
export function publicDatasetTaskLabel(taskType: string | null | undefined): string | null {
  if (taskType === "detect") return "目标检测";
  if (taskType === "classify") return "图像分类";
  return null;
}

/** 紧凑展示热度数字，无数据时返回 null */
export function formatCompactCount(value: number | null | undefined): string | null {
  if (value == null || value <= 0) return null;
  if (value >= 100_000) return `${(value / 10_000).toFixed(0)}万`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return compactNumberFormatter.format(value);
}

/** 候选卡片只展示真实图片缩略图；标注渲染层不能作为封面。 */
export function candidatePreviewUrl(candidate: {
  annotation_thumbnail?: string | null;
  thumbnail?: string | null;
}): string | null {
  return candidate.thumbnail || null;
}

/** 展示类别标签，超出上限时附加 +N */
export function formatCandidateClasses(classes: string[], limit = 4): { visible: string[]; overflow: number } {
  const cleaned = classes.map((item) => item.trim()).filter(Boolean);
  if (cleaned.length <= limit) return { visible: cleaned, overflow: 0 };
  return { visible: cleaned.slice(0, limit), overflow: cleaned.length - limit };
}
