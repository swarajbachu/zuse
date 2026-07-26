Pod::Spec.new do |s|
  s.name           = 'ZuseMobileTerminal'
  s.version        = '1.0.0'
  s.summary        = 'Native terminal surface for paired development environments.'
  s.description    = 'Expo view bridge for rendering and interacting with an authenticated remote PTY.'
  s.author         = 'Zuse'
  s.homepage       = 'https://zuse.sh'
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.exclude_files = 'Tests/**/*'

  spm_dependency(
    s,
    url: 'https://github.com/migueldeicaza/SwiftTerm',
    requirement: { kind: 'exactVersion', version: '1.14.0' },
    products: ['SwiftTerm']
  )

  s.test_spec 'Tests' do |ts|
    ts.source_files = 'Tests/**/*.swift'
  end
end
