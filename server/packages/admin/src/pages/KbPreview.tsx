/**
 * 知识库前端移植的**视觉样板页**（临时验收页，非产品功能）。
 *
 * 目的：让「像不像 BuildingAI」这件事能在浏览器里**直接肉眼验收**，而不是等全部搬完才发现观感不对。
 * 页面把移植来的组件摆一遍（按钮/卡片/徽标/表格/标签页/输入/开关/进度/分页…），
 * 全部包在 `<div className="reactor-kb-scope">` 里 ——
 *
 * ★ 作用域就是这一层的意义：`theme.css` 里那份 4.6k 行的 token 已被改成
 * `.reactor-kb-scope { … }`（Tailwind v4 的 `@theme` 只能顶层，会覆盖我们自己后台的语义色）。
 * 于是**这个子树内是 BuildingAI 的配色/圆角/字号，其它后台页面完全不受影响**。
 *
 * 验收方式：`/console/kb-preview`（见 `layouts/console.tsx` 里注册的路由）。
 * 后续正式页面按 `docs/实施计划/知识库前端-移植清单-v1.md` §8 推进，届时本页删除。
 */
import {
  ArrowClockwise,
  DownloadSimple,
  FileText,
  MagnifyingGlass,
  Plus,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import { Button } from "../kb-port/ui/components/ui/button";
import { Badge } from "../kb-port/ui/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../kb-port/ui/components/ui/card";
import { Input } from "../kb-port/ui/components/ui/input";
import { Label } from "../kb-port/ui/components/ui/label";
import { Progress } from "../kb-port/ui/components/ui/progress";
import { Separator } from "../kb-port/ui/components/ui/separator";
import { Switch } from "../kb-port/ui/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../kb-port/ui/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../kb-port/ui/components/ui/tabs";
import "../kb-port/theme/theme.css";

const DEMO_ROWS = [
  { name: "2026Q3 储能复盘.md", segments: 42, chars: "18.6k", mode: "混合检索", state: "已索引" },
  { name: "配电网承载能力评估.pdf", segments: 156, chars: "73.2k", mode: "向量", state: "已索引" },
  { name: "并网技术规范（征求意见稿）.docx", segments: 88, chars: "41.0k", mode: "关键词", state: "索引中" },
];

export default function KbPreview(): React.ReactElement {
  return (
    <div className="reactor-kb-scope">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">知识库（组件样板）</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              本页只用于验收移植组件的观感：配色、圆角、间距、按钮与表格密度均来自 BuildingAI 的 design token。
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm">
              <ArrowClockwise /> 刷新
            </Button>
            <Button size="sm">
              <Plus /> 新建数据集
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardDescription>数据集</CardDescription>
              <CardTitle className="text-3xl">3</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">部门库 2 · 全员库 1</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>文档 / 片段</CardDescription>
              <CardTitle className="text-3xl">
                286 <span className="text-muted-foreground text-base font-normal">/ 12.4k</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">近 7 天新增 24 篇</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>向量化进度</CardDescription>
              <CardTitle className="text-3xl">86%</CardTitle>
            </CardHeader>
            <CardContent>
              <Progress value={86} />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="text-base">配电网知识库</CardTitle>
              <CardDescription>可见范围：部门 · 片段 500 字 / 重叠 50</CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <Badge>部门</Badge>
              <div className="flex items-center gap-2">
                <Switch defaultChecked id="kb-auto" />
                <Label htmlFor="kb-auto" className="text-sm">
                  自动向量化
                </Label>
              </div>
            </div>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6">
            <Tabs defaultValue="docs">
              <div className="flex items-center justify-between gap-4">
                <TabsList>
                  <TabsTrigger value="docs">文档</TabsTrigger>
                  <TabsTrigger value="members">成员</TabsTrigger>
                  <TabsTrigger value="retrieval">检索配置</TabsTrigger>
                </TabsList>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <MagnifyingGlass className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4" />
                    <Input placeholder="搜索文档…" className="w-56 pl-8" />
                  </div>
                  <Button variant="outline" size="sm">
                    <UploadSimple /> 上传
                  </Button>
                </div>
              </div>

              <TabsContent value="docs" className="mt-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead className="w-24 text-right">片段</TableHead>
                      <TableHead className="w-24 text-right">字数</TableHead>
                      <TableHead className="w-28">检索模式</TableHead>
                      <TableHead className="w-24">状态</TableHead>
                      <TableHead className="w-16" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {DEMO_ROWS.map((r) => (
                      <TableRow key={r.name}>
                        <TableCell className="flex items-center gap-2 font-medium">
                          <FileText className="text-muted-foreground size-4" />
                          {r.name}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.segments}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.chars}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{r.mode}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={r.state === "已索引" ? "default" : "outline"}>{r.state}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="icon">
                            <Trash />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>

              <TabsContent value="members" className="text-muted-foreground mt-4 text-sm">
                成员与申请（样板占位：正式页按移植清单 §3 接 `/v1/kb/datasets/:id/members`）。
              </TabsContent>
              <TabsContent value="retrieval" className="text-muted-foreground mt-4 text-sm">
                检索配置（样板占位：模式 vector / lexical / hybrid + 片段参数 + topK）。
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">按钮层级：</span>
          <Button size="sm">主操作</Button>
          <Button size="sm" variant="secondary">
            次级
          </Button>
          <Button size="sm" variant="outline">
            描边
          </Button>
          <Button size="sm" variant="ghost">
            幽灵
          </Button>
          <Button size="sm" variant="destructive">
            <DownloadSimple /> 危险
          </Button>
        </div>
      </div>
    </div>
  );
}
