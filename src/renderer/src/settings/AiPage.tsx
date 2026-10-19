import { KeyRound, ShieldCheck, Sparkles, Wand2 } from 'lucide-react'
import type { AiTestResult, Settings } from '@shared/types'
import type { AiProviderChoice } from './types'
import {
  Badge,
  Button,
  Callout,
  Card,
  PageHead,
  Row,
  SectionHead,
  Segmented,
  Switch
} from './ui'

const PROVIDER_OPTIONS: ReadonlyArray<{ value: AiProviderChoice; label: string }> = [
  { value: 'siliconflow', label: '硅基流动' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI 兼容' }
]

export interface AiPageProps {
  settings: Settings
  providerChoice: AiProviderChoice
  testBusy: boolean
  testResult: AiTestResult | null
  onPatch: (partial: Partial<Settings>) => void
  onProvider: (choice: AiProviderChoice) => void
  onTest: () => void
  onClearTest: () => void
}

export default function AiPage(props: AiPageProps): JSX.Element {
  const { settings, providerChoice, testBusy, testResult, onPatch, onProvider, onTest } = props
  const on = settings.aiSummaryEnabled
  const isAnthropic = settings.aiProvider === 'anthropic'

  return (
    <div className="pp-page">
      <PageHead
        eyebrow="STOP SUMMARY"
        title="AI 总结"
        subtitle="任务停下时，用一句人话告诉你发生了什么。用你自己的模型，Key 只存在本机。"
        actions={
          <Badge tone={on ? 'sage' : 'neutral'} dot>
            {on ? '已开启 · 可选联网' : '已关闭 · 不联网'}
          </Badge>
        }
      />

      <section className={`pp-ai-hero${on ? ' is-on' : ''}`}>
        <div className="pp-ai-hero__icon">
          <Sparkles size={22} />
        </div>
        <div className="pp-ai-hero__copy">
          <strong>{on ? '开头一句规则，补一句人话' : '现在先安静陪伴'}</strong>
          <p>
            {on
              ? '只有单条 Agent 终态才会生成总结；多 Agent 合并提醒、失败或超时都会自动回落到规则文案，提醒永远不会缺席。'
              : '打开后配置模型服务，Agent 停下时气泡会多一句具体说明。关闭时这个功能完全不联网。'}
          </p>
        </div>
        <Switch
          label="启用 AI 总结"
          checked={on}
          onChange={(value) => {
            props.onClearTest()
            onPatch({ aiSummaryEnabled: value })
          }}
        />
      </section>

      {on && (
        <section className="pp-section">
          <SectionHead title="模型服务" hint="按你手头已有的服务选一种，不必四家都配。" />
          <Card padded={false} className="pp-settings-card">
            <Row
              title="服务商"
              desc={
                providerChoice === 'siliconflow'
                  ? '一键预设，Base URL 固定为 api.siliconflow.cn/v1。'
                  : providerChoice === 'anthropic'
                    ? '使用 Anthropic 官方接口。'
                    : '任何 OpenAI 格式的接口：OpenAI、DeepSeek、月之暗面、Ollama 等。'
              }
              control={
                <Segmented
                  options={PROVIDER_OPTIONS}
                  value={providerChoice}
                  onChange={onProvider}
                  label="模型服务"
                />
              }
            />

            {!isAnthropic && providerChoice === 'openai' && (
              <Row
                title="Base URL"
                desc="只有本机 http（127.0.0.1 / localhost）或 https 会被接受。"
                control={
                  <input
                    key={`base:${settings.aiOpenaiBaseUrl}`}
                    className="pp-input pp-input--wide"
                    type="text"
                    spellCheck={false}
                    placeholder="https://api.openai.com/v1"
                    defaultValue={settings.aiOpenaiBaseUrl}
                    onBlur={(event) => onPatch({ aiOpenaiBaseUrl: event.target.value })}
                  />
                }
              />
            )}

            <Row
              title="API Key"
              icon={<KeyRound size={14} />}
              desc="经 macOS 钥匙串加密后只保存在本机，不会同步到任何地方。"
              control={
                <input
                  key={`key:${isAnthropic ? settings.aiAnthropicApiKey : settings.aiOpenaiApiKey}`}
                  className="pp-input pp-input--wide"
                  type="password"
                  autoComplete="off"
                  placeholder={isAnthropic ? 'sk-ant-…' : 'sk-…'}
                  defaultValue={isAnthropic ? settings.aiAnthropicApiKey : settings.aiOpenaiApiKey}
                  onBlur={(event) =>
                    onPatch(
                      isAnthropic
                        ? { aiAnthropicApiKey: event.target.value }
                        : { aiOpenaiApiKey: event.target.value }
                    )
                  }
                />
              }
            />

            <Row
              title="模型 ID"
              desc={
                providerChoice === 'siliconflow'
                  ? '按硅基流动模型广场的名字填；默认 DeepSeek-V3.1，拥堵时可换 Qwen 系列。'
                  : providerChoice === 'anthropic'
                    ? '默认 claude-opus-4-8；追求更快更省可改成 claude-haiku-4-5。'
                    : '例如 gpt-4o-mini、deepseek-chat、qwen2.5:7b。'
              }
              control={
                <input
                  key={`model:${isAnthropic ? settings.aiAnthropicModel : settings.aiOpenaiModel}`}
                  className="pp-input pp-input--wide"
                  type="text"
                  spellCheck={false}
                  placeholder={
                    providerChoice === 'siliconflow'
                      ? 'deepseek-ai/DeepSeek-V3.1'
                      : isAnthropic
                        ? 'claude-opus-4-8'
                        : 'gpt-4o-mini'
                  }
                  defaultValue={isAnthropic ? settings.aiAnthropicModel : settings.aiOpenaiModel}
                  onBlur={(event) =>
                    onPatch(
                      isAnthropic
                        ? { aiAnthropicModel: event.target.value }
                        : { aiOpenaiModel: event.target.value }
                    )
                  }
                />
              }
            />
          </Card>

          <div className="pp-test-row">
            <Button
              variant="secondary"
              icon={<Wand2 size={15} />}
              loading={testBusy}
              onClick={onTest}
            >
              {testBusy ? '测试中' : '测试连接'}
            </Button>
            <span className="pp-test-row__hint">用内置样例发一次真实请求，不会读取你的项目。</span>
          </div>

          {testResult && (
            <div className={`pp-test-result${testResult.ok ? ' is-ok' : ' is-error'}`}>
              <strong>{testResult.ok ? '连接成功' : '连接失败'}</strong>
              <p>
                {testResult.ok
                  ? `这是模型对内置样例的总结演示：「${testResult.text}」`
                  : testResult.error}
              </p>
            </div>
          )}
        </section>
      )}

      <Callout tone="neutral" icon={<ShieldCheck size={16} />}>
        <strong>隐私说明</strong>
        <span>
          这是可选联网功能。仅在任务停下的那一刻，把该会话末尾的少量文本（最多 6000 字符）
          发给你自己配置的模型服务；API Key 只保存在本机。关闭时此功能完全不联网。
        </span>
      </Callout>

      <section className="pp-section">
        <SectionHead title="什么时候会用到" />
        <div className="pp-ai-steps">
          <div>
            <span>01</span>
            <strong>Agent 停下</strong>
            <p>只读取该会话末尾，不碰项目代码。</p>
          </div>
          <div>
            <span>02</span>
            <strong>生成一句总结</strong>
            <p>最多 12 秒、300 tokens，超时即放弃。</p>
          </div>
          <div>
            <span>03</span>
            <strong>拼进气泡</strong>
            <p>规则结论始终保留，AI 只补充第二行细节。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
