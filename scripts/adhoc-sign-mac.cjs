const { createRequire } = require('node:module')
const { join } = require('node:path')

const requireFromProject = createRequire(join(process.cwd(), 'package.json'))
const { signAsync } = requireFromProject('@electron/osx-sign')

exports.default = async function adhocSignMac(context) {
  if (process.platform !== 'darwin' || context.electronPlatformName !== 'darwin') return

  const productName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${productName}.app`)

  await signAsync({
    app: appPath,
    identity: '-',
    identityValidation: false,
    platform: 'darwin',
    version: context.packager.config.electronVersion || undefined,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: false,
    optionsForFile: () => ({
      hardenedRuntime: false,
      timestamp: 'none'
    })
  })
}
