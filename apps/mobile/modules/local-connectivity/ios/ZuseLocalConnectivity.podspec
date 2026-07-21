Pod::Spec.new do |s|
  s.name           = 'ZuseLocalConnectivity'
  s.version        = '1.0.0'
  s.summary        = 'Nearby Mac discovery and Apple peer-to-peer transport.'
  s.description    = 'Network.framework bridge for direct local connectivity.'
  s.author         = 'Zuse'
  s.homepage       = 'https://zuse.sh'
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.frameworks = 'Network', 'Security', 'CryptoKit'
end
