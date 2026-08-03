import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 패키징 설정(D-025, 배포 요건은 D-039).
 * 앱 문서 Origin은 androidScheme에 따라 `https://localhost`가 되며,
 * 이 값은 서버 CORS 허용목록에 포함되어야 한다(D-026).
 *
 * 평문 HTTP 허용(allowMixedContent)은 제거했다 — 배포 빌드는 HTTPS API만 쓴다.
 * 로컬에서 http 서버로 네이티브 테스트가 필요하면 그때만 임시로 되살리고 배포 전에 되돌린다.
 *
 * 주의: 플랫폼 추가와 APK·IPA 빌드는 이 저장소에서 검증하지 않았다.
 * `npx cap add android`는 @capacitor/android와 Android SDK가 필요하고(현재 미설치),
 * iOS는 macOS와 Xcode가 필요하다(현재 개발 환경은 Windows라 불가).
 * iOS 기본 스킴은 `capacitor://localhost`이므로 iOS를 다룰 때 허용목록 또는 iosScheme을 함께 정한다.
 */
const config: CapacitorConfig = {
  appId: 'kr.victory1944.app',
  appName: 'Victory 1944',
  webDir: 'dist',
};

export default config;
