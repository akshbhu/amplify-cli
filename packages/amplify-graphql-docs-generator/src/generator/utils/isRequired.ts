import { GraphQLType, isNonNullType, isListType } from "graphql";
export default function isRequired(typeObj: GraphQLType): boolean {
  if (isNonNullType(typeObj) && isListType(typeObj.ofType)) {
    return isRequired(typeObj.ofType.ofType)
  }
  return isNonNullType(typeObj);
}