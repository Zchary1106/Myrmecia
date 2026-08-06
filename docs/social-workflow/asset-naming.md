# 社媒资产命名与存储规范

## 命名

所有可发布资产必须使用以下形式，并在运行快照中记录**绝对路径**：

```text
{content_id}_{platform}_{asset_type}_{version}_{timestamp}.{ext}
```

示例：

```text
social-20260804-ai-note-01_douyin_video_v1_20260804T093000Z.mp4
social-20260804-ai-note-01_xiaohongshu_card-01_v1_20260804T093000Z.png
social-20260804-ai-note-01_wechat_cover_v1_20260804T093000Z.png
```

## 目录

```text
artifacts/social/{content_id}/
  source/        # 人工原始素材，只读保存
  generated/     # 卡片、封面、剪辑输出
  reports/       # QA、合规、预检、发布与监控 JSON
```

## 规则

- 路径必须为绝对路径，发布前由媒体 QA 校验存在性。
- 不记录账号令牌、Cookie、电话号码或私密 URL 到运行快照。
- 原始素材与生成结果保留版本号；不得覆盖已发布内容的资产。
- 发布结果、草稿 ID、media_id 和人工审批记录保存在 `reports/`，用于审计与补偿。
