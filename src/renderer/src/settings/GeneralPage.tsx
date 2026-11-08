import {
  Compass,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Power,
  RotateCcw,
  ShieldCheck
} from 'lucide-react'
import type { Snapshot } from '@shared/types'
import { Badge, Button, Callout, Card, PageHead, Row, SectionHead, Switch } from './ui'
import logoUrl from '../assets/logo.png'

export interface GeneralPageProps {
  snapshot: Snapshot
  onResetPosition: () => void
  onToggleVisible: () => void
  onReveal: () => void
  onQuit: () => void
}

export default function GeneralPage(props: GeneralPageProps): JSX.Element {
  const { snapshot } = props
  const { settings, appVersion } = snapshot

  return (
    <div className="pp-page">
      <PageHead
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
        <SectionHead title="版本" hint="PingPet 不会自己联网检查更新，新版本请到官网或 GitHub Releases 下载。" />
        <Card padded={false} className="pp-settings-card">
          <Row
            title="当前版本"
            desc="yvestiny-aipm.github.io/pingpet"
            icon={<Download size={15} />}
            control={<span className="pp-version">v{appVersion}</span>}
          />
        </Card>
      </section>

      <Callout tone="neutral" icon={<ShieldCheck size={16} />}>
        <strong>隐私边界</strong>
        <span>
          核心监控纯本地、只读；没有账号，也没有遥测。唯一会联网的是 PetDex 形象库，而且只在你主动打开它时。
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
