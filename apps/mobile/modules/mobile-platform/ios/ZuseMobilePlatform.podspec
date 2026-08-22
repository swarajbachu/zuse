Pod::Spec.new do |s|
  s.name           = 'ZuseMobilePlatform'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS document, media, and background-task support.'
  s.description    = 'Expo bridge for platform capabilities used by the mobile client.'
  s.author         = 'Zuse'
  s.homepage       = 'https://zuse.sh'
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
