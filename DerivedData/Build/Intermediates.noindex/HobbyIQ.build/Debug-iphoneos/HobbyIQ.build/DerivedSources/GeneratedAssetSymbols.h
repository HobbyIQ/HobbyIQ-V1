#import <Foundation/Foundation.h>

#if __has_attribute(swift_private)
#define AC_SWIFT_PRIVATE __attribute__((swift_private))
#else
#define AC_SWIFT_PRIVATE
#endif

/// The "hobbyiq_icon" asset catalog image resource.
static NSString * const ACImageNameHobbyiqIcon AC_SWIFT_PRIVATE = @"hobbyiq_icon";

/// The "hobbyiq_logo" asset catalog image resource.
static NSString * const ACImageNameHobbyiqLogo AC_SWIFT_PRIVATE = @"hobbyiq_logo";

#undef AC_SWIFT_PRIVATE
