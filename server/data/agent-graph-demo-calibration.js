export const DEMO_DATASET_VERSION = '2026.08.1';

export const CALIBRATION_SOURCES = Object.freeze([
  {
    id: 'cnnic-2024-online-music',
    title: 'The 54th Statistical Report on China\'s Internet Development',
    publisher: 'China Internet Network Information Center',
    publishedAt: '2024-11-01',
    url: 'https://www.cnnic.com.cn/IDR/ReportDownloads/202411/P020241101318428715781.pdf',
    facts: [
      'China had 729 million online-music users as of June 2024.',
      'Online-music users represented 66.3% of Chinese internet users.',
    ],
  },
  {
    id: 'tme-fy2025',
    title: 'Tencent Music Entertainment Group Fourth Quarter and Full-Year 2025 Results',
    publisher: 'Tencent Music Entertainment Group',
    publishedAt: '2026-03-17',
    url: 'https://ir.tencentmusic.com/2026-03-17-Tencent-Music-Entertainment-Group-Announces-Fourth-Quarter-and-Full-Year-2025-Unaudited-Financial-Results',
    facts: [
      'TME reported 528 million online-music MAUs in Q4 2025.',
      'TME reported 127.4 million online-music paying users and RMB11.9 monthly ARPPU in Q4 2025.',
      'TME identifies QQ Music, Kugou Music, Kuwo Music and WeSing as its major music apps.',
    ],
  },
  {
    id: 'netease-cloud-music-fy2025',
    title: 'NetEase Cloud Music Fiscal Year 2025 Results',
    publisher: 'NetEase Cloud Music Inc.',
    publishedAt: '2026-02-11',
    url: 'https://www.prnewswire.com/news-releases/netease-cloud-music-inc-reports-fiscal-year-2025-financial-results-302684933.html',
    facts: [
      'NetEase Cloud Music reported a DAU/MAU ratio above 30% in 2025.',
      'Membership-subscription revenue reached RMB5.1 billion in 2025.',
    ],
  },
  {
    id: 'nbs-2025-population-employment',
    title: 'Statistical Communique of the PRC on 2025 National Economic and Social Development',
    publisher: 'National Bureau of Statistics of China',
    publishedAt: '2026-02-28',
    url: 'https://www.stats.gov.cn/english/PressRelease/202602/t20260228_1962661.html',
    facts: [
      'Mainland China year-end population was 1,404.89 million in 2025.',
      'Urban residents represented 67.9% of the population and employed people totaled 725.04 million.',
    ],
  },
  {
    id: 'nbs-2025-wages',
    title: 'Average Annual Wages of Employees in Urban Units in 2025',
    publisher: 'National Bureau of Statistics of China',
    publishedAt: '2026-05-16',
    url: 'https://www.stats.gov.cn/english/PressRelease/202605/t20260518_1963740.html',
    facts: [
      'Average annual wages were RMB129,441 in urban non-private units and RMB71,590 in private units.',
      'Published occupation-group averages inform the income-band calibration.',
    ],
  },
]);

export const MUSIC_APPS = Object.freeze([
  { id: 'qq-music', name: 'QQ音乐', category: '综合音乐', company: 'Tencent Music', baseDau: 73_000_000, dailyInstalls: 315_000, uninstallRate: 0.0038, payingRate: 0.245, tracksPerActive: 15.4, minutesPerActive: 72, annualTrend: -0.015 },
  { id: 'kugou-music', name: '酷狗音乐', category: '综合音乐', company: 'Tencent Music', baseDau: 69_000_000, dailyInstalls: 292_000, uninstallRate: 0.0041, payingRate: 0.198, tracksPerActive: 16.2, minutesPerActive: 77, annualTrend: -0.025 },
  { id: 'kuwo-music', name: '酷我音乐', category: '综合音乐', company: 'Tencent Music', baseDau: 22_000_000, dailyInstalls: 108_000, uninstallRate: 0.0044, payingRate: 0.171, tracksPerActive: 14.1, minutesPerActive: 69, annualTrend: -0.035 },
  { id: 'wesing', name: '全民K歌', category: '在线K歌', company: 'Tencent Music', baseDau: 18_500_000, dailyInstalls: 96_000, uninstallRate: 0.0052, payingRate: 0.118, tracksPerActive: 7.1, minutesPerActive: 48, annualTrend: -0.045 },
  { id: 'netease-cloud-music', name: '网易云音乐', category: '综合音乐', company: 'NetEase Cloud Music', baseDau: 61_000_000, dailyInstalls: 286_000, uninstallRate: 0.0040, payingRate: 0.232, tracksPerActive: 16.8, minutesPerActive: 82, annualTrend: 0.035 },
  { id: 'soda-music', name: '汽水音乐', category: '推荐流音乐', company: 'ByteDance', baseDau: 43_000_000, dailyInstalls: 358_000, uninstallRate: 0.0058, payingRate: 0.086, tracksPerActive: 18.4, minutesPerActive: 75, annualTrend: 0.22 },
  { id: 'migu-music', name: '咪咕音乐', category: '运营商音乐', company: 'China Mobile', baseDau: 14_500_000, dailyInstalls: 73_000, uninstallRate: 0.0036, payingRate: 0.154, tracksPerActive: 12.7, minutesPerActive: 61, annualTrend: 0.015 },
  { id: 'bodian-music', name: '波点音乐', category: '推荐流音乐', company: 'Kugou', baseDau: 12_500_000, dailyInstalls: 98_000, uninstallRate: 0.0061, payingRate: 0.052, tracksPerActive: 17.2, minutesPerActive: 67, annualTrend: 0.08 },
  { id: 'apple-music', name: 'Apple Music', category: '订阅制音乐', company: 'Apple', baseDau: 5_800_000, dailyInstalls: 22_000, uninstallRate: 0.0025, payingRate: 0.615, tracksPerActive: 14.5, minutesPerActive: 70, annualTrend: 0.04 },
  { id: 'spotify', name: 'Spotify', category: '国际音乐', company: 'Spotify', baseDau: 2_900_000, dailyInstalls: 31_000, uninstallRate: 0.0064, payingRate: 0.282, tracksPerActive: 15.8, minutesPerActive: 74, annualTrend: 0.07 },
  { id: 'ximalaya', name: '喜马拉雅', category: '音频与播客', company: 'Ximalaya', baseDau: 38_000_000, dailyInstalls: 173_000, uninstallRate: 0.0043, payingRate: 0.139, tracksPerActive: 5.4, minutesPerActive: 58, annualTrend: 0.01 },
  { id: 'qingting-fm', name: '蜻蜓FM', category: '音频与播客', company: 'Qingting FM', baseDau: 8_200_000, dailyInstalls: 44_000, uninstallRate: 0.0049, payingRate: 0.093, tracksPerActive: 4.8, minutesPerActive: 51, annualTrend: -0.02 },
]);

export const PROVINCES = Object.freeze([
  ['广东', 0.090], ['山东', 0.072], ['河南', 0.070], ['四川', 0.059], ['江苏', 0.060],
  ['河北', 0.052], ['湖南', 0.047], ['浙江', 0.046], ['安徽', 0.043], ['湖北', 0.041],
  ['广西', 0.036], ['云南', 0.034], ['江西', 0.032], ['辽宁', 0.030], ['福建', 0.030],
  ['陕西', 0.028], ['黑龙江', 0.023], ['山西', 0.025], ['贵州', 0.027], ['重庆', 0.023],
  ['吉林', 0.017], ['甘肃', 0.018], ['内蒙古', 0.017], ['新疆', 0.018], ['上海', 0.018],
  ['北京', 0.016], ['天津', 0.010], ['海南', 0.007], ['宁夏', 0.005], ['青海', 0.004], ['西藏', 0.003],
]);

export const REGION_BY_PROVINCE = Object.freeze({
  北京: '华北', 天津: '华北', 河北: '华北', 山西: '华北', 内蒙古: '华北',
  辽宁: '东北', 吉林: '东北', 黑龙江: '东北',
  上海: '华东', 江苏: '华东', 浙江: '华东', 安徽: '华东', 福建: '华东', 江西: '华东', 山东: '华东',
  河南: '华中', 湖北: '华中', 湖南: '华中',
  广东: '华南', 广西: '华南', 海南: '华南',
  重庆: '西南', 四川: '西南', 贵州: '西南', 云南: '西南', 西藏: '西南',
  陕西: '西北', 甘肃: '西北', 青海: '西北', 宁夏: '西北', 新疆: '西北',
});

export const CITY_TIERS = Object.freeze([
  ['一线', 0.095], ['新一线', 0.205], ['二线', 0.235], ['三线', 0.225], ['四线', 0.145], ['五线及以下', 0.095],
]);

export const ACQUISITION_CHANNELS = Object.freeze([
  ['应用商店自然量', 0.31], ['信息流广告', 0.19], ['短视频内容', 0.16], ['品牌广告', 0.08],
  ['社交分享', 0.10], ['设备预装', 0.07], ['运营商渠道', 0.05], ['其他', 0.04],
]);

export const PROFILE_DISTRIBUTIONS = Object.freeze({
  gender: [['男', 0.505], ['女', 0.493], ['未说明', 0.002]],
  age_band: [['15-17', 0.035], ['18-24', 0.205], ['25-34', 0.310], ['35-44', 0.220], ['45-54', 0.135], ['55-64', 0.075], ['65+', 0.020]],
  education: [['初中及以下', 0.185], ['高中/中专', 0.285], ['大专', 0.225], ['本科', 0.270], ['硕士及以上', 0.035]],
  industry: [
    ['制造业', 0.160], ['信息技术与互联网', 0.105], ['批发零售', 0.105], ['教育', 0.075],
    ['住宿餐饮与生活服务', 0.085], ['交通运输与物流', 0.070], ['金融', 0.045], ['医疗健康', 0.055],
    ['建筑与房地产', 0.070], ['文化传媒与娱乐', 0.045], ['公共管理', 0.045], ['农业', 0.050],
    ['学生', 0.080], ['其他', 0.060],
  ],
  occupation: [
    ['专业技术人员', 0.165], ['办事人员', 0.145], ['生产制造人员', 0.135], ['商业服务人员', 0.125],
    ['管理人员', 0.070], ['个体经营者', 0.085], ['物流与驾驶人员', 0.065], ['教师', 0.050],
    ['医护人员', 0.035], ['学生', 0.085], ['农业从业者', 0.035], ['自由职业者', 0.040], ['其他', 0.030],
  ],
  income_band: [['3000元以下', 0.155], ['3000-5999元', 0.285], ['6000-9999元', 0.265], ['10000-19999元', 0.205], ['20000-39999元', 0.070], ['40000元以上', 0.020]],
  device_price_band: [['1000元以下', 0.105], ['1000-1999元', 0.235], ['2000-3999元', 0.355], ['4000-5999元', 0.195], ['6000元以上', 0.110]],
  device_brand: [['华为', 0.205], ['苹果', 0.175], ['小米', 0.165], ['OPPO', 0.145], ['vivo', 0.145], ['荣耀', 0.105], ['其他安卓', 0.060]],
  music_preference: [['流行', 0.275], ['华语', 0.180], ['经典老歌', 0.135], ['说唱', 0.085], ['摇滚', 0.070], ['民谣', 0.065], ['电子', 0.055], ['古典', 0.035], ['国风', 0.055], ['播客/有声书', 0.045]],
  listening_scene: [['通勤', 0.245], ['工作学习', 0.205], ['睡前', 0.145], ['运动', 0.105], ['驾车', 0.115], ['家务', 0.080], ['社交聚会', 0.045], ['其他', 0.060]],
});

export const DATA_NATURE = Object.freeze({
  type: 'synthetic_panel_calibrated_to_public_aggregates',
  isRealUserData: false,
  containsPersonalInformation: false,
  reportPanelDevices: 5_000_000,
  reportOutputScope: 'weighted_national_estimates_from_synthetic_panel',
  reportAggregation: 'active_users and paying_users are additive daily user-days; divide by the number of days for an average daily estimate',
  audienceProfiles: 100_000,
  policy: 'No hand-planted anomaly, target answer, or special cohort effect. Values are deterministic draws from shared marginal and correlation rules.',
  limitation: 'App-level installs, uninstalls, retention and individual tags are not publicly disclosed facts. Treat them as realistic test estimates, not market truth.',
});
