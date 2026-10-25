import { useQuery } from '@tanstack/react-query'
import { api } from './format'

export function useRegistries() {
  return useQuery({ queryKey: ['registries'], queryFn: () => api.registries.list(), staleTime: Infinity })
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.settings.get(), staleTime: Infinity })
}

export function useDockerStorage() {
  return useQuery({
    queryKey: ['docker-storage'],
    queryFn: () => api.docker.storageInfo(),
    staleTime: 10_000
  })
}
