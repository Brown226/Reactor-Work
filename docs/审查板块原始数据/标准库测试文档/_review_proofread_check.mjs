// 校对复现脚本：从 docx XML 重建正文，跑确定性检查，并复核已上报的 27 条定位。
// 用法：先 unzip -o -q <docx> -d _ddzx_x，再 node _review_proofread_check.mjs
import fs from 'node:fs';
import path from 'node:path';

const base = process.cwd();
const SRC = path.join(base, '_ddzx_x', 'word');
const OUT_TEXT = path.join(base, '_审查正文-智能辅助设计平台-软件说明书.recheck.txt');

const doc = fs.readFileSync(path.join(SRC, 'document.xml'), 'utf8');
const numbering = fs.readFileSync(path.join(SRC, 'numbering.xml'), 'utf8');
const styles = fs.readFileSync(path.join(SRC, 'styles.xml'), 'utf8');

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function paraText(pXml) {
  let out = '';
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>/g;
  let m;
  while ((m = re.exec(pXml))) {
    if (m[0].startsWith('<w:br')) out += '\n';
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else out += decode(m[1]);
  }
  return out;
}
const paraStyle = (p) => (p.match(/<w:pStyle w:val="([^"]*)"/) || [, ''])[1];
const paraNum = (p) => {
  const m = p.match(/<w:numPr>[\s\S]*?<w:ilvl w:val="(\d+)"[\s\S]*?<w:numId w:val="(\d+)"/);
  return m ? { ilvl: +m[1], numId: +m[2] } : null;
};

// ---- 1. 重建正文（阅读顺序，表格按行） ----
const body = (doc.match(/<w:body>([\s\S]*)<\/w:body>/) || [, doc])[1];
const blocks = [];
{
  const re = /<w:(p|tbl)(?:\s[^>]*)?>([\s\S]*?)<\/w:\1>/g;
  let m;
  while ((m = re.exec(body))) blocks.push({ kind: m[1], xml: m[2] });
}

const lines = [];
for (const b of blocks) {
  if (b.kind === 'p') {
    for (const part of paraText(b.xml).replace(/\n+$/, '').split('\n')) lines.push(part);
  } else {
    const rows = b.xml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || [];
    for (const r of rows) {
      const cells = [];
      for (const c of r.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || []) {
        const ps = c.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
        cells.push(ps.map((p) => paraText(p).replace(/\n+/g, ' ')).join(' ').trim());
      }
      lines.push('| ' + cells.join(' | ') + ' |');
    }
  }
}
const text = lines.join('\n');
fs.writeFileSync(OUT_TEXT, text, 'utf8');
console.log(`[1] 正文重建：块 ${blocks.length}，行 ${lines.length}，字符 ${text.length}`);

// ---- 2. 标题样式 / 编号模拟 ----
const styleName = {};
for (const m of styles.matchAll(/<w:style [^>]*w:styleId="([^"]*)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
  const n = m[2].match(/<w:name w:val="([^"]*)"/);
  styleName[m[1]] = n ? n[1] : m[1];
}
const absOf = {};
for (const m of numbering.matchAll(/<w:num w:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)"/g)) absOf[m[1]] = m[2];
const lvlDef = {};
for (const m of numbering.matchAll(/<w:abstractNum [^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
  const defs = {};
  for (const l of m[2].matchAll(/<w:lvl w:ilvl="(\d+)">([\s\S]*?)<\/w:lvl>/g)) {
    defs[l[1]] = {
      fmt: (l[2].match(/<w:numFmt w:val="([^"]*)"/) || [, 'none'])[1],
      txt: (l[2].match(/<w:lvlText w:val="([^"]*)"/) || [, ''])[1],
      start: +((l[2].match(/<w:start w:val="([^"]*)"/) || [, '1'])[1]),
    };
  }
  lvlDef[m[1]] = defs;
}
console.log(`[2] 重新编号(restartOverride)声明数：${(numbering.match(/<w:lvlOverride|<w:startOverride/g) || []).length}（0 = 各级编号全文档连续）`);

// 按文档顺序模拟编号
const counters = {}; // key: numId -> array per level
const headingStyles = {};
const bulletHeadings = [];
const rendered = []; // {text, label}
for (const b of blocks) {
  if (b.kind !== 'p') continue;
  const t = paraText(b.xml).split('\n')[0].trim();
  if (!t) continue;
  const st = paraStyle(b.xml);
  const np = paraNum(b.xml);
  if (st) headingStyles[styleName[st] || st] = (headingStyles[styleName[st] || st] || 0) + 1;
  if (!np) continue;
  const defs = lvlDef[absOf[np.numId]] || {};
  const d = defs[np.ilvl];
  if (!d) continue;
  counters[np.numId] = counters[np.numId] || [];
  counters[np.numId][np.ilvl] = (counters[np.numId][np.ilvl] || d.start - 1) + 1;
  for (let deeper = np.ilvl + 1; deeper < 9; deeper++) counters[np.numId][deeper] = undefined;
  let label;
  if (d.fmt === 'decimal') {
    label = d.txt.replace(/%(\d)/g, (_, n) => String(counters[np.numId][+n - 1] ?? ''));
  } else {
    label = d.fmt === 'bullet' ? '•' : null;
  }
  rendered.push({ t, label, numId: np.numId, ilvl: np.ilvl, fmt: d.fmt });
  if (np.numId === 9 && np.ilvl === 0 && /^[0-9]/.test(t)) bulletHeadings.push(t);
}
console.log(`[3] 套用标题样式的段落：`, headingStyles);
console.log(`[4] 挂在项目符号列表(numId=9)上的标题 ${bulletHeadings.length} 个：`);
for (const h of bulletHeadings) console.log('      • ' + h);

console.log('\n[5] 第 7 章 Q/A 条目在 Word 中的实际编号（编号模拟结果）：');
let inQA = false;
for (const r of rendered) {
  if (/^Q\d/.test(r.t)) inQA = true;
  if (!inQA) continue;
  if (r.fmt !== 'decimal') continue;
  console.log(`      ${r.label.padEnd(5)} ${r.t.slice(0, 44)}`);
}

// ---- 3. 错别字词典 ----
const TYPO = [['帐号','账号'],['帐户','账户'],['帐目','账目'],['帐单','账单'],['帐面','账面'],['帐务','账务'],['帐期','账期'],['帐龄','账龄'],['记帐','记账'],['报帐','报账'],['结帐','结账'],['查帐','查账'],['应收帐款','应收账款'],['应付帐款','应付账款'],['按装','安装'],['按奈','按捺'],['暴炸','爆炸'],['必竟','毕竟'],['布署','部署'],['苍桑','沧桑'],['穿流不息','川流不息'],['防患未燃','防患未然'],['幅射','辐射'],['幅射剂量','辐射剂量'],['鬼计','诡计'],['宏扬','弘扬'],['即然','既然'],['秸杆','秸秆'],['竞竞业业','兢兢业业'],['刻服','克服'],['脉博','脉搏'],['密秘','秘密'],['棉棉不断','绵绵不断'],['磨擦','摩擦'],['脑怒','恼怒'],['偏辟','偏僻'],['迫不急待','迫不及待'],['气慨','气概'],['揉躪','蹂躏'],['散慢','散漫'],['善长','擅长'],['声张正义','伸张正义'],['提心掉胆','提心吊胆'],['通谍','通牒'],['消遥','逍遥'],['修养生息','休养生息'],['渲泄','宣泄'],['一愁莫展','一筹莫展'],['饮鸠止渴','饮鸩止渴'],['元霄','元宵'],['震憾','震撼'],['尊守','遵守'],['座落','坐落'],['不经而走','不胫而走'],['不径而走','不胫而走'],['莫明其妙','莫名其妙'],['默守成规','墨守成规'],['漫生','蔓生'],['曼生','蔓生'],['陈词烂调','陈词滥调'],['泛烂','泛滥'],['烂用','滥用'],['烂调','滥调'],['缺矢','缺失'],['企待','期待'],['企途','企图'],['企画','企划'],['另为','另外'],['除次之外','除此之外'],['观于','关于'],['目地','目的'],['目地地','目的地'],['严历','严厉'],['严利','严厉'],['历害','厉害'],['利害了','厉害了'],['专致','专一'],['贯澈','贯彻'],['澈底','彻底'],['清沏','清澈'],['体显','体现'],['成现','呈现'],['表显','表现'],['再显','再现'],['发显','发现'],['发名','发明'],['发殿','发展'],['发答','发达'],['发步','发布'],['公步','公布'],['宣步','宣布'],['宣靠','宣告'],['靠知','告知'],['通抱','通报'],['抱告','报告'],['会报','汇报'],['回付','回复'],['答付','答复'],['批覆','批复'],['回付了','回复了'],['己经','已经'],['己然','已然'],['末到','未到'],['末来','未来'],['戊戍','戊戌'],['答券','答卷'],['考券','考卷'],['入券','入卷'],['和霭','和蔼'],['暮蔼','暮霭'],['雾蔼','雾霭'],['竣工验心','竣工验收'],['工程结账','工程结算'],['反映堆','反应堆'],['气轮机','汽轮机'],['水蒸汽','水蒸气'],['混泥土','混凝土'],['焊结','焊接'],['罗栓','螺栓'],['罗母','螺母'],['法心','法兰'],['防府','防腐'],['保稳','保温'],['秘封','密封'],['渗露','渗漏'],['安全窍','安全壳'],['同位数','同位素'],['热交交换','热交换'],['热器换','热交换器'],['防热层','隔热层'],['砼土','砼'],['签定','签订'],['制订标准','制定标准'],['成包','承包'],['合冋','合同'],['协仪','协议'],['赔赏','赔偿'],['补赏','补偿'],['索赏','索赔'],['一副画','一幅画'],['一颗树','一棵树'],['一棵药','一颗药'],['一幅药','一副药'],['一幅眼镜','一副眼镜'],['一个硬币','一枚硬币'],['一辆飞机','一架飞机'],['一架设备','一台设备'],['一宗设备','一台设备'],['一把机关枪','一挺机关枪'],['一辆火车','一列火车'],['一条马','一匹马'],['一条牛','一头牛'],['一头羊','一只羊'],['一只鱼','一条鱼'],['百废待新','百废待兴'],['变本加利','变本加厉'],['仗义直言','仗义执言'],['旁证博引','旁征博引'],['略见一般','略见一斑'],['按步就班','按部就班'],['飞扬拔扈','飞扬跋扈'],['拔山涉水','跋山涉水'],['卑恭屈膝','卑躬屈膝'],['并行不背','并行不悖'],['不加思索','不假思索'],['不屈不饶','不屈不挠'],['草管人命','草菅人命'],['趁心如意','称心如意'],['出类拔粹','出类拔萃'],['出奇不意','出其不意'],['处心集虑','处心积虑'],['唇枪舌箭','唇枪舌剑'],['粗枝大意','粗心大意'],['打报不平','打抱不平'],['大声急呼','大声疾呼'],['当人不让','当仁不让'],['倒打一把','倒打一耙'],['独树一炽','独树一帜'],['额首称庆','额手称庆'],['繁文辱节','繁文缛节'],['翻云复雨','翻云覆雨'],['分道扬标','分道扬镳'],['风毛麟角','凤毛麟角'],['刚腹自用','刚愎自用'],['功亏一匮','功亏一篑'],['鬼斧神功','鬼斧神工'],['含辛如苦','含辛茹苦'],['汗流夹背','汗流浃背'],['好高鹜远','好高骛远'],['积毁消骨','积毁销骨'],['矫揉造做','矫揉造作'],['金碧辉黄','金碧辉煌'],['鞠躬尽粹','鞠躬尽瘁'],['苦心孤意','苦心孤诣'],['老奸巨滑','老奸巨猾'],['历兵秣马','厉兵秣马'],['厉精图治','励精图治'],['美仑美奂','美轮美奂'],['明辩是非','明辨是非'],['明查秋毫','明察秋毫'],['名符其实','名副其实'],['冒然行事','贸然行事'],['怒不可扼','怒不可遏'],['披星带月','披星戴月'],['破斧沉舟','破釜沉舟'],['巧夺天功','巧夺天工'],['磬竹难书','罄竹难书'],['趋之若骛','趋之若鹜'],['人才倍出','人才辈出'],['世外桃园','世外桃源'],['随声附合','随声附和'],['无可非异','无可非议'],['无所是从','无所适从'],['虚无飘渺','虚无缥缈'],['鸦鹊无声','鸦雀无声'],['言简意该','言简意赅'],['坐想其成','坐享其成'],['坐无虚席','座无虚席']];
let typo = 0;
for (const [w, r] of TYPO) { const n = text.split(w).length - 1; if (n) { typo += n; console.log(`      命中 ${w} → ${r} ×${n}`); } }
console.log(`\n[6] 错别字词典：${TYPO.length} 条，命中 ${typo} 处`);

// ---- 4. 标点/单位确定性检查 ----
console.log('\n[7] 标点与排版检查：');
const checks = [
  ['多余顿号（。）后跟、', /。、/g],
  ['省略号误用三个半角点', /\.\.\./g],
  ['半角括号包裹中文', /\([^)]*[\u4e00-\u9fa5][^)]*\)/g],
  ['全角逗号后跟空格', /，\s/g],
  ['全角括号后跟空格', /）[ \u00a0]/g],
  ['引号前后夹空格', /[“”]\s|\s[“”]/g],
  ['不换行空格 U+00A0', /\u00a0/g],
  ['分辨率用字母x', /\d[xX]\d/g],
  ['数值单位间距 带空格', /\d+\s(?:GB|TB|MB)\b/g],
  ['数值单位间距 不带空格', /\d+(?:GB|TB|MB|Mbps)/g],
];
for (const [name, re] of checks) {
  const hits = [...text.matchAll(re)];
  console.log(`      ${name}：${hits.length} 处`);
  if (hits.length && hits.length <= 8) for (const h of hits.slice(0, 4)) console.log('         …' + text.slice(Math.max(0, h.index - 14), h.index + h[0].length + 14).replace(/\n/g, '⏎') + '…');
}

// ---- 5. 复核已上报的 27 条定位 ----
const QUOTES = ['三维物象尺寸标注操作','退出安装向导。、','4. 核心功能操作指南','验证系统是否满足最低运行环境要求（尤其是.NET Framework版本）。','可点击“浏览...”按钮自行选择目标文件夹','“正在识别表格结构...”、“正在提取文本...”等进度提示','Windows 7 (64位)','CAD (MCP服务)配置','支持DirectX 11， 2GB显存','务必在AutoCAD中手动保存（Ctrl+S）','本软件定位为 “面向工程设计领域的智能交互中台与效率工具” 。','500 GB HDD，剩余空间≥10GB','结合了基于规则图形分析（识别线框）和基于机器学习文本布局分析的方法','将复杂指令拆分成更短、更明确的几个指令','E3D服务配置：类似CAD配置，需指定E3D服务的主机地址和端口','能够高鲁棒性地处理CAD图纸中格式不统一、甚至略有破损的表格','状态栏显示“CAD: 连接失败”','用户可在UI上轻松切换','（如材料表、设备清单、统计表）','实现了对AutoCAD的“语音控制”','自动侦测DWG文件中的表格结构','把今天上传的三个图纸里的所有物料表，合并成一个总表。','| 处理器 | Intel i5-4代或AMD同等性能，4核 | Intel i7-10代/AMD Ryzen 5以上，6核及以上 |','分辨率 1920x1080','| 组件 | 最低配置 | 推荐配置 |','软件的灵魂在于背后的AI引擎','试着发一个非常简单的指令'];
let uniq = 0, multi = 0, miss = 0;
for (const q of QUOTES) {
  const n = text.split(q).length - 1;
  if (n === 1) uniq++; else if (n > 1) { multi++; console.log(`      多次出现(${n})：${q.slice(0, 40)}`); } else { miss++; console.log(`      未找到：${q.slice(0, 40)}`); }
}
console.log(`\n[8] 27 条定位复核：唯一匹配 ${uniq}，多次出现 ${multi}，未找到 ${miss}`);
