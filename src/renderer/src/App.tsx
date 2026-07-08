import { useEffect, useState } from 'react'
import PetView from './components/PetView'
import SettingsView from './components/SettingsView'

type Route = 'pet' | 'settings'

function currentRoute(): Route {
  return window.location.hash.includes('settings') ? 'settings' : 'pet'
}

export default function App(): JSX.Element {
  const [route] = useState<Route>(currentRoute)

  useEffect(() => {
    document.title = route === 'settings' ? '桌宠设置' : '桌宠'
    document.body.dataset.route = route
  }, [route])

  useEffect(() => {
    const preventNavigationDrop = (event: DragEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('dragover', preventNavigationDrop)
    window.addEventListener('drop', preventNavigationDrop)
    return () => {
      window.removeEventListener('dragover', preventNavigationDrop)
      window.removeEventListener('drop', preventNavigationDrop)
    }
  }, [])

  return route === 'settings' ? <SettingsView /> : <PetView />
}
