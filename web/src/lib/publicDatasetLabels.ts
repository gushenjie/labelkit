/** 公开数据导入流程状态（面向国内用户的展示文案） */
export const PUBLIC_IMPORT_STATE_ZH: Record<string, string> = {
  created: "已创建",
  fetching: "下载分析中",
  fetched: "待映射发布",
  fetch_failed: "下载失败",
  fetch_interrupted: "下载中断",
  publishing: "发布中",
  publish_interrupted: "发布中断",
  needs_label: "待标注",
  review: "抽样复查",
  review_expanded: "扩大抽样",
  full_review_required: "需全量复查",
  published: "已发布",
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
