import {
  Compass,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Power,
  RefreshCw,
  RotateCcw,
  ShieldCheck
} from 'lucide-react'
import type { Settings, Snapshot } from '@shared/types'
import { Badge, Button, Callout, Card, PageHead, Row, SectionHead, Switch } from './ui'
import logoUrl from '../assets/logo.png'

export interface GeneralPageProps {
  snapshot: Snapshot
  onPatch: (partial: Partial<Settings>) => void
  onResetPosition: () => void
  onToggleVisible: () => void
  onReveal: () => void
  onQuit: () => void
}

export default function GeneralPage(props: GeneralPageProps): JSX.Element {
  const { snapshot, onPatch } = props
  const { settings, appVersion } = snapshot

  return (
    <div className="pp-page">
      <PageHead
        eyebrow="PREFERENCES"
        title="通用设置"
        subtitle="把桌面调成你舒服的样子。所有设置都只保存在本机。"
        actions={<Badge tone="neutral">v{appVersion}</Badge>}
      />

      <section className="pp-section">
        <SectionHead title="桌面" hint="随时让小伙伴回来，或把它挪到顺手的位置。" />
        <Card padded={false} className="pp-settings-card">
          <Row
            title="显示桌宠"
            desc="隐藏后桌宠和所有气泡都会消失，Agent 监控仍在后台运行。"
            icon={settings.petVisible ? <Eye size={15} /> : <EyeOff size={15} />}
            control={
              <Switch
                label="显示桌宠"
                checked={settings.petVisible}
                onChange={props.onToggleVisible}
              />
            }
          />
          <Row
            title="桌宠位置"
            desc="挪回主屏右下角的默认位置，并重新收进屏幕内。"
            icon={<Compass size={15} />}
            control={
              <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={props.onResetPosition}>
                重置位置
              </Button>
            }
          />
          <Row
            title="导入目录"
            desc="在 Finder 里查看已导入的皮肤包，删除或备份都可以。"
            icon={<FolderOpen size={15} />}
            control={
              <Button variant="ghost" onClick={props.onReveal}>
                打开
              </Button>
            }
          />
        </Card>
      </section>

      <section className="pp-section">
        <SectionHead title="更新" hint="有新版本时弹一次气泡，并在菜单栏留一个下载入口。" />
        <Card padded={false} className="pp-settings-card">
          <Row
            title="检查新版本"
            desc="每天检查一次。只向 GitHub 取一个版本号，不上传任何关于你的信息。"
            icon={<RefreshCw size={15} />}
            control={
              <Switch
                label="检查新版本"
                checked={settings.updateCheckEnabled}
                onChange={(value) => onPatch({ updateCheckEnabled: value })}
              />
            }
          />
          <Row
            title="当前版本"
            desc="暂不支持一键静默更新——需要 Apple Developer ID 签名和公证。发现新版本会打开下载页。"
            icon={<Download size={15} />}
            control={<span className="pp-version">v{appVersion}</span>}
          />
        </Card>
      </section>

      <Callout tone="neutral" icon={<ShieldCheck size={16} />}>
        <strong>隐私边界</strong>
        <span>
          核心监控纯本地、只读；没有账号，也没有遥测。只有三件事会联网：
          PetDex 形象库（你主动打开时）、AI 总结（你显式开启时）、更新检查（默认开，可在这里关掉）。
          API Key 使用 macOS 钥匙串加密，只保存在本机。
        </span>
      </Callout>

      <section className="pp-section">
        <SectionHead title="关于 PingPet" />
        <div className="pp-about">
          <img src={logoUrl} alt="" className="pp-about__logo" />
          <div className="pp-about__copy">
            <h3>PingPet</h3>
            <p>一个安静住在桌面上的小伙伴。替你盯着 AI，忙时绝不打扰。</p>
            <div className="pp-about__meta">
              <span>v{appVersion}</span>
              <span>macOS · Apple Silicon</span>
              <span>本地优先</span>
            </div>
          </div>
          <Button variant="ghost" icon={<Power size={14} />} onClick={props.onQuit}>
            退出 PingPet
          </Button>
        </div>
      </section>
    </div>
  )
}
