/**
 * Content Studio profiles — Team-driven configuration.
 *
 * Each entry keys a Content Studio variant to a Team (Team Contract v2).
 * Selecting a studio variant switches the stage stepper, the pipeline filter,
 * the create-run naming, and the empty-state guidance. Adding a new platform
 * means adding a profile + the Team's roles/skills — the main page no longer
 * branches on hardcoded agent ids (T18).
 */

export interface ContentStudioStage {
  name: string;
  agentRole: string;
}

export interface ContentStudioProfile {
  teamId: string;
  shortLabel: string;
  templateName: string;
  title: string;
  subtitle: string;
  stages: ContentStudioStage[];
  createLabel: string;
  emptyHint: string;
}

export const CONTENT_TEAM_IDS = ['xiaohongshu', 'douyin', 'content', 'social-three-lanes'] as const;

export const CONTENT_STUDIO_PROFILES: Record<string, ContentStudioProfile> = {
  xiaohongshu: {
    teamId: 'xiaohongshu',
    shortLabel: 'Xiaohongshu',
    templateName: 'Xiaohongshu Publish',
    title: 'Xiaohongshu Content Studio',
    subtitle: '小红书独立生产线 · 图文预览 · 人工审核发布',
    stages: [
      { name: '小红书选题调研', agentRole: 'researcher' },
      { name: '小红书笔记创作', agentRole: 'content-creator' },
      { name: '自动合规初筛', agentRole: 'review' },
      { name: '人工审核材料', agentRole: 'review' },
      { name: '配图生成', agentRole: 'ui' },
      { name: '媒体 QA', agentRole: 'qa' },
      { name: '发布预检', agentRole: 'ops' },
      { name: '小红书发布', agentRole: 'ops' },
    ],
    createLabel: 'Create Xiaohongshu run',
    emptyHint: 'Research, write, review, generate images, and explicitly approve publication from one artifact-first workspace.',
  },
  douyin: {
    teamId: 'douyin',
    shortLabel: 'Douyin',
    templateName: 'Douyin Video Publish',
    title: 'Douyin Script & Publish Studio',
    subtitle: '脚本与发布工作台 · 需要用户提供真实本地视频 · 人工确认上传',
    stages: [
      { name: '抖音选题调研', agentRole: 'researcher' },
      { name: '抖音视频脚本', agentRole: 'content-creator' },
      { name: '自动合规初筛', agentRole: 'review' },
      { name: '人工审核材料', agentRole: 'review' },
      { name: '视频媒体 QA', agentRole: 'qa' },
      { name: '发布预检', agentRole: 'ops' },
      { name: '抖音视频发布', agentRole: 'ops' },
      { name: '发布补偿计划', agentRole: 'ops' },
      { name: '发布后监控计划', agentRole: 'ops' },
    ],
    createLabel: 'Create Douyin video run',
    emptyHint: 'Research, write the video script, validate a real local video file, then explicitly approve the Douyin upload.',
  },
  content: {
    teamId: 'content',
    shortLabel: 'WeChat',
    templateName: 'WeChat Article',
    title: 'WeChat Official Account Studio',
    subtitle: '选题 · 写作 · 审核 · 排版 · 草稿箱 · 人工发布',
    stages: [
      { name: '选题分析', agentRole: 'master' },
      { name: '内容创作', agentRole: 'content-creator' },
      { name: '内容审核', agentRole: 'review' },
      { name: '排版优化', agentRole: 'content-creator' },
      { name: '草稿箱同步', agentRole: 'ops' },
      { name: '发布执行', agentRole: 'ops' },
    ],
    createLabel: 'Create WeChat article run',
    emptyHint: 'Research, write, review, and lay out long-form WeChat content, then explicitly approve the draft sync and publish.',
  },
  'social-three-lanes': {
    teamId: 'social-three-lanes',
    shortLabel: 'Crosspost',
    templateName: 'Social Content Three Lanes',
    title: 'Social Three-Lane Studio',
    subtitle: 'Douyin + Xiaohongshu + WeChat · shared research · independent production lanes',
    stages: [
      { name: 'GitHub 仓库事实包', agentRole: 'researcher' },
      { name: '选题证据包', agentRole: 'researcher' },
      { name: '内容核心包', agentRole: 'pm' },
      { name: '抖音视频生产线', agentRole: 'content-creator' },
      { name: '小红书生产线', agentRole: 'content-creator' },
      { name: '公众号生产线', agentRole: 'content-creator' },
      { name: '自动合规初筛', agentRole: 'review' },
      { name: '人工审核材料', agentRole: 'review' },
      { name: '小红书卡片生成', agentRole: 'ui' },
      { name: '公众号草稿箱同步', agentRole: 'ops' },
      { name: '媒体 QA', agentRole: 'qa' },
      { name: '发布预检', agentRole: 'ops' },
      { name: '发布执行', agentRole: 'ops' },
      { name: '发布补偿计划', agentRole: 'ops' },
      { name: '发布后监控计划', agentRole: 'ops' },
    ],
    createLabel: 'Create crosspost run',
    emptyHint: 'Share research and a content core, then run independent Douyin, Xiaohongshu, and WeChat production lanes from one workspace.',
  },
};

export function studioProfileForTeam(teamId: string): ContentStudioProfile {
  return CONTENT_STUDIO_PROFILES[teamId] || CONTENT_STUDIO_PROFILES['social-three-lanes'];
}

/** Match a pipeline to a profile by template id, then by stage-name signature. */
export function pipelineMatchesProfile(
  pipeline: { templateId?: string | null; stages: Array<{ name?: string }> },
  profile: ContentStudioProfile,
  templateId?: string,
): boolean {
  if (templateId && pipeline.templateId === templateId) return true;
  const stageNames = pipeline.stages.map(stage => String(stage.name || ''));
  const profileNames = profile.stages.map(stage => stage.name);
  const overlap = profileNames.filter(name => stageNames.some(stageName => stageName.includes(name) || name.includes(stageName)));
  return overlap.length >= 2;
}
