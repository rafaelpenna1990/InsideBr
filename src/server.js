Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.

PS C:\Users\rpenna\OneDrive - SLB\Desktop\Personal\InsideBr\insider-app> $env:EAS_NO_VCS=1
PS C:\Users\rpenna\OneDrive - SLB\Desktop\Personal\InsideBr\insider-app> npx eas-cli update --branch preview --message "Documentos abrem sem forcar download"
Using EAS CLI without version control system is not recommended, use this mode only if you know what you are doing.
Failed to get Git root path with `git rev-parse --show-toplevel`. Error: spawn git ENOENT
Falling back to using current working directory as project root.
You can set `EAS_PROJECT_ROOT` environment variable to let eas-cli know where your project is located.
EAS project not configured.
√ Which account should own this project? » rpenna1990
√ Existing EAS project found for @rpenna1990/insidebr-app (id = 5af58793-09ae-4820-9b7d-10e682d8642e). Configure this project? ... yes
√ Linked local project to EAS project 5af58793-09ae-4820-9b7d-10e682d8642e
√ Select environment: » preview
> npx expo install expo-updates
[expo-cli] › Installing 1 SDK 57.0.0 compatible native module using npm
[expo-cli] > npm install
[expo-cli] up to date, audited 519 packages in 9s
[expo-cli] 55 packages are looking for funding
[expo-cli]   run `npm fund` for details
[expo-cli] 13 moderate severity vulnerabilities
[expo-cli]
[expo-cli] To address issues that do not require attention, run:
[expo-cli]   npm audit fix
[expo-cli]
[expo-cli] To address all issues (including breaking changes), run:
[expo-cli]   npm audit fix --force
[expo-cli]
[expo-cli] Run `npm audit` for details.
√ Installed expo-updates
√ Configured updates.url to "https://u.expo.dev/5af58793-09ae-4820-9b7d-10e682d8642e"
√ Configured runtimeVersion for Android and iOS with "{"policy":"appVersion"}"

All builds of your app going forward will be eligible to receive updates published with EAS Update.

[expo-cli] --non-interactive is not supported, use $CI=1 instead
[expo-cli] Starting Metro Bundler
[expo-cli] Android Bundled 7879ms node_modules\expo\AppEntry.js (1118 modules)
[expo-cli] iOS Bundled 12756ms node_modules\expo\AppEntry.js (1121 modules)
[expo-cli] Creating asset map
[expo-cli]
[expo-cli] › Assets (43):
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\AntDesign.ttf (130KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\Entypo.ttf (66KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\EvilIcons.ttf (13KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\Feather.ttf (56KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\FontAwesome.ttf (166KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\FontAwesome5_Brands.ttf (134KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\FontAwesome5_Regular.ttf (34KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\FontAwesome5_Solid.ttf (203KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\FontAwesome6_Brands.ttf (209KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\FontAwesome6_Regular.ttf (68KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\FontAwesome6_Solid.ttf (424KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\Fontisto.ttf (314KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\Foundation.ttf (57KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\Ionicons.ttf (390KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\MaterialCommunityIcons.ttf (1.3MB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\MaterialIcons.ttf (357KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\Octicons.ttf (69KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\SimpleLineIcons.ttf (54KB)
[expo-cli] node_modules\@expo\vector-icons\build\vendor\react-native-vector-icons\Fonts\Zocial.ttf (26KB)
[expo-cli] node_modules\@react-navigation\elements\lib\module\assets\back-icon-mask.png (653B)
[expo-cli] node_modules\@react-navigation\elements\lib\module\assets\back-icon.png (8 variations | 359B)
[expo-cli] node_modules\@react-navigation\elements\lib\module\assets\clear-icon.png (4 variations | 425B)
[expo-cli] node_modules\@react-navigation\elements\lib\module\assets\close-icon.png (4 variations | 235B)
[expo-cli] node_modules\@react-navigation\elements\lib\module\assets\search-icon.png (7 variations | 592B)
[expo-cli] › android bundles (2):
[expo-cli] _expo/static/js/android/AppEntry-1b0bf6afb26a5844e5ce1190cd64820f.hbc (2.2MB)
[expo-cli] _expo/static/js/android/AppEntry-1b0bf6afb26a5844e5ce1190cd64820f.hbc.map (5.2MB)
[expo-cli]
[expo-cli] › ios bundles (2):
[expo-cli] _expo/static/js/ios/AppEntry-13f44aa6a708a65c77aa02f48f7d6fa1.hbc (2.2MB)
[expo-cli] _expo/static/js/ios/AppEntry-13f44aa6a708a65c77aa02f48f7d6fa1.hbc.map (5.2MB)
[expo-cli]
[expo-cli] › Files (2):
[expo-cli] assetmap.json (22KB)
[expo-cli] metadata.json (4.8KB)
[expo-cli]
[expo-cli] Exported: dist
√ Exported bundle(s)
√ Uploaded assetmap.json
√ Uploaded 2 app bundles
√ Uploading assets skipped - no new assets found
i 36 iOS assets, 37 Android assets (maximum: 2000 total per update). Learn more about asset limits: https://expo.fyi/eas-update-asset-limits
√ Computed project fingerprints
√ Published!
Branch             preview
Runtime version    1.0.0
Platform           android, ios
Update group ID    d866e9a4-a18a-4ebd-9c00-c1583d72778e
Android update ID  01a0ab7b-14a7-7cc2-b393-f1ddd6b24b22
iOS update ID      01a0ab7b-14a7-7b86-8c5e-dc666a06b92b
Message            Documentos abrem sem forcar download
EAS Dashboard      https://expo.dev/accounts/rpenna1990/projects/insidebr-app/updates/d866e9a4-a18a-4ebd-9c00-c1583d72778e

PS C:\Users\rpenna\OneDrive - SLB\Desktop\Personal\InsideBr\insider-app>
